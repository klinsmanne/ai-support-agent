-- =============================================================================
-- Hardening (from milestone C security review)
-- 1. Dashboard users are read-only at the database level. Every mutation (approve an
--    escalation, change settings, close a ticket) goes through a server route that
--    re-checks membership + role, validates input with Zod, and writes the audit log.
--    Row-level UPDATE policies can't restrict *which columns* change, so we remove them.
-- 2. Database-level bounds on tenant settings mirror the Zod schema (defense in depth).
-- 3. Tighten Supabase default grants for current and future objects.
-- 4. Make keyword retrieval robust to any input characters; fix double stemming.
-- 5. Close remaining referential gaps (from code-quality review).
-- =============================================================================

-- 1. Read-only dashboard role
drop policy if exists owner_update on public.tenant_settings;
drop policy if exists agent_update on public.escalations;
drop policy if exists agent_update on public.tickets;

revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- 2. Settings bounds (match src/lib/tenants/config.ts)
alter table public.tenant_settings
  add constraint refund_limit_cap check (refund_auto_approve_limit_cents <= 100000),
  add constraint max_refunds_cap check (max_refunds_per_customer_30d <= 20),
  add constraint sentiment_range check (escalate_on_negative_sentiment_below between -1 and 0),
  add constraint confidence_range check (min_confidence_to_act between 0 and 1),
  add constraint escalation_always_enabled check ('escalate_to_human' = any (enabled_tools)),
  add constraint known_tools check (enabled_tools <@ array[
    'get_customer', 'get_orders', 'get_ticket_history', 'search_knowledge_base',
    'issue_refund', 'update_order', 'send_reply', 'escalate_to_human'
  ]),
  add constraint ticket_cap check (daily_ticket_cap <= 10000),
  add constraint replies_cap check (max_ai_replies_per_thread <= 20);

-- 4. Keyword leg: strip backslashes before quoting so quote_literal never emits E'' strings
create or replace function public.match_kb_chunks(
  p_tenant_id uuid,
  p_query_embedding extensions.vector(768),
  p_query_text text,
  p_match_count integer default 5
)
returns table (chunk_id uuid, document_id uuid, title text, slug text, content text, similarity double precision, score double precision)
language sql
stable
set search_path = public, extensions
-- Keep scanning the HNSW index past other tenants' rows so a tenant still gets enough candidates.
set hnsw.iterative_scan = 'relaxed_order'
as $$
  with semantic as (
    select c.id, row_number() over (order by c.embedding <=> p_query_embedding) as rank,
           1 - (c.embedding <=> p_query_embedding) as similarity
    from kb_chunks c
    where c.tenant_id = p_tenant_id and c.embedding is not null and p_query_embedding is not null
    order by c.embedding <=> p_query_embedding
    limit 20
  ),
  query as (
    select to_tsquery('simple', string_agg(quote_literal(replace(lexeme, E'\\', '')), ' | ')) as q
    from unnest(to_tsvector('english', coalesce(p_query_text, '')))
    where replace(lexeme, E'\\', '') <> ''
  ),
  keyword as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, query.q) desc) as rank
    from kb_chunks c, query
    where c.tenant_id = p_tenant_id and query.q is not null and c.fts @@ query.q
    order by ts_rank_cd(c.fts, query.q) desc
    limit 20
  ),
  fused as (
    select coalesce(s.id, k.id) as id,
           coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as score,
           s.similarity
    from semantic s full outer join keyword k on s.id = k.id
  )
  select c.id, c.document_id, d.title, d.slug, c.content, f.similarity, f.score
  from fused f
  join kb_chunks c on c.id = f.id
  join kb_documents d on d.id = c.document_id and d.tenant_id = p_tenant_id
  order by f.score desc, c.id
  limit least(greatest(p_match_count, 1), 10);
$$;

revoke all on function public.match_kb_chunks(uuid, extensions.vector, text, integer) from public, anon, authenticated;
grant execute on function public.match_kb_chunks(uuid, extensions.vector, text, integer) to service_role;

-- 5. Referential integrity for IDs that previously had no foreign key
alter table public.agent_runs add constraint agent_runs_tenant_id_key unique (tenant_id, id);
alter table public.messages add constraint messages_tenant_id_key unique (tenant_id, id);

alter table public.chat_sessions
  add constraint chat_sessions_ticket_fk foreign key (tenant_id, ticket_id)
    references public.tickets (tenant_id, id) on delete set null (ticket_id),
  add constraint chat_sessions_customer_fk foreign key (tenant_id, verified_customer_id)
    references public.customers (tenant_id, id) on delete set null (verified_customer_id);
alter table public.refunds
  add constraint refunds_ticket_fk foreign key (tenant_id, ticket_id)
    references public.tickets (tenant_id, id) on delete set null (ticket_id);
alter table public.escalations
  add constraint escalations_run_fk foreign key (tenant_id, run_id)
    references public.agent_runs (tenant_id, id) on delete set null (run_id);
alter table public.processed_messages
  add constraint processed_messages_ticket_fk foreign key (tenant_id, ticket_id)
    references public.tickets (tenant_id, id) on delete set null (ticket_id);
alter table public.agent_runs
  add constraint agent_runs_trigger_message_fk foreign key (tenant_id, trigger_message_id)
    references public.messages (tenant_id, id) on delete set null (trigger_message_id);

-- Removing a dashboard user must not fail because they once approved something.
alter table public.refunds drop constraint refunds_decided_by_user_fkey,
  add constraint refunds_decided_by_user_fkey foreign key (decided_by_user) references auth.users (id) on delete set null;
alter table public.escalations drop constraint escalations_resolved_by_fkey,
  add constraint escalations_resolved_by_fkey foreign key (resolved_by) references auth.users (id) on delete set null;

-- get_ticket_history: a customer's recent tickets
create index tickets_customer_idx on public.tickets (tenant_id, customer_id, created_at desc);
