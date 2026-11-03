-- =============================================================================
-- AI Customer Support Operations Agent — initial schema
-- Multi-tenant: every business row carries tenant_id. Row Level Security is
-- enabled on every table. Dashboard users (role `authenticated`) can only read
-- rows of tenants they belong to; the backend uses the service role and always
-- scopes queries by tenant explicitly (defense in depth).
-- =============================================================================

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.rollout_mode as enum ('shadow', 'draft_only', 'auto_send');
create type public.member_role as enum ('owner', 'agent', 'viewer');
create type public.channel_type as enum ('email', 'chat');
create type public.ticket_status as enum (
  'new', 'in_progress', 'awaiting_customer', 'resolved', 'escalated', 'closed', 'needs_attention'
);
create type public.message_direction as enum ('inbound', 'outbound');
create type public.message_author as enum ('customer', 'ai', 'human', 'system');
create type public.message_status as enum (
  'received', 'draft', 'pending_approval', 'sent', 'rejected', 'failed'
);
create type public.order_status as enum (
  'pending', 'processing', 'shipped', 'delayed', 'delivered', 'cancelled', 'returned'
);
create type public.refund_status as enum ('approved', 'pending_approval', 'rejected');
create type public.escalation_status as enum ('pending', 'approved', 'edited', 'rejected');
create type public.actor_type as enum ('ai', 'human', 'system');
create type public.trace_event_type as enum (
  'model_call', 'tool_call', 'retrieval', 'guardrail', 'decision', 'error'
);

-- ---------------------------------------------------------------------------
-- Tenants and membership
-- ---------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  name text not null,
  industry text not null default 'ecommerce',
  created_at timestamptz not null default now()
);

-- All per-client behaviour lives here: onboarding a client is configuration, not code.
create table public.tenant_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  rollout_mode public.rollout_mode not null default 'shadow',
  kill_switch boolean not null default false,
  refund_auto_approve_limit_cents integer not null default 5000 check (refund_auto_approve_limit_cents >= 0),
  max_refunds_per_customer_30d integer not null default 2 check (max_refunds_per_customer_30d >= 0),
  escalate_on_negative_sentiment_below numeric(3, 2) not null default -0.60,
  min_confidence_to_act numeric(3, 2) not null default 0.70,
  enabled_tools text[] not null default array[
    'get_customer', 'get_orders', 'get_ticket_history', 'search_knowledge_base',
    'issue_refund', 'update_order', 'send_reply', 'escalate_to_human'
  ],
  brand_name text not null,
  brand_voice text not null,
  supported_languages text[] not null default array['en'],
  allowed_link_domains text[] not null default array[]::text[],
  support_email text,
  csat_enabled boolean not null default true,
  daily_ticket_cap integer not null default 300 check (daily_ticket_cap > 0),
  max_ai_replies_per_thread integer not null default 6 check (max_ai_replies_per_thread > 0),
  retention_days integer not null default 90 check (retention_days between 7 and 3650),
  updated_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'agent',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on public.tenant_members (user_id);

-- ---------------------------------------------------------------------------
-- Commerce data (simulated system of record)
-- ---------------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  email text not null check (email = lower(email)),
  name text not null,
  preferred_language text not null default 'en',
  plan text, -- SaaS tenants
  created_at timestamptz not null default now(),
  unique (tenant_id, email),
  unique (tenant_id, id)
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid not null,
  order_number text not null,
  status public.order_status not null,
  currency text not null default 'USD',
  total_cents integer not null check (total_cents >= 0),
  items jsonb not null default '[]'::jsonb,
  shipping_address jsonb not null default '{}'::jsonb,
  carrier text,
  tracking_number text,
  estimated_delivery date,
  placed_at timestamptz not null default now(),
  shipped_at timestamptz,
  delivered_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (tenant_id, order_number),
  unique (tenant_id, id),
  -- Composite FK guarantees an order's customer belongs to the same tenant.
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete cascade
);
create index orders_customer_idx on public.orders (tenant_id, customer_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null,
  customer_id uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'captured' check (status in ('captured', 'refunded', 'partially_refunded')),
  captured_at timestamptz not null default now(),
  foreign key (tenant_id, order_id) references public.orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete cascade
);
create index payments_order_idx on public.payments (tenant_id, order_id);

-- ---------------------------------------------------------------------------
-- Tickets, messages, idempotency
-- ---------------------------------------------------------------------------
create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid,
  channel public.channel_type not null,
  status public.ticket_status not null default 'new',
  subject text,
  requester_email text,
  sender_verified boolean not null default false,
  external_thread_id text,
  intent text,
  urgency text check (urgency in ('low', 'normal', 'high', 'urgent')),
  sentiment numeric(3, 2) check (sentiment between -1 and 1),
  language text,
  is_spam boolean not null default false,
  injection_suspected boolean not null default false,
  ai_reply_count integer not null default 0,
  csat_score smallint check (csat_score between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  first_response_at timestamptz,
  resolved_at timestamptz,
  escalated_at timestamptz,
  closed_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete set null (customer_id)
);
create index tickets_queue_idx on public.tickets (tenant_id, status, updated_at desc);
create unique index tickets_thread_idx on public.tickets (tenant_id, channel, external_thread_id)
  where external_thread_id is not null;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null,
  direction public.message_direction not null,
  author public.message_author not null,
  status public.message_status not null,
  body text not null,
  provider_message_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key (tenant_id, ticket_id) references public.tickets (tenant_id, id) on delete cascade
);
create index messages_ticket_idx on public.messages (tenant_id, ticket_id, created_at);

-- Idempotency: a provider message is processed at most once, ever.
create table public.processed_messages (
  provider text not null,
  provider_message_id text not null,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid,
  processed_at timestamptz not null default now(),
  primary key (provider, provider_message_id)
);

-- ---------------------------------------------------------------------------
-- Actions requested by the agent and approved by code / humans
-- ---------------------------------------------------------------------------
create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null,
  customer_id uuid not null,
  ticket_id uuid,
  amount_cents integer not null check (amount_cents > 0),
  reason text not null,
  status public.refund_status not null,
  decided_by public.actor_type not null,
  decided_by_user uuid references auth.users (id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, order_id) references public.orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete cascade
);
create index refunds_customer_idx on public.refunds (tenant_id, customer_id, created_at desc);

create table public.escalations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null,
  run_id uuid,
  reason_codes text[] not null,
  summary text not null,
  investigation jsonb not null default '{}'::jsonb,
  suggested_reply text,
  pending_action jsonb, -- e.g. a refund awaiting human approval
  status public.escalation_status not null default 'pending',
  resolved_by uuid references auth.users (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, ticket_id) references public.tickets (tenant_id, id) on delete cascade
);
create index escalations_pending_idx on public.escalations (tenant_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Observability: agent runs, trace events, audit log, usage
-- ---------------------------------------------------------------------------
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null,
  trigger_message_id uuid,
  provider text not null,
  model text not null,
  prompt_version text not null,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  outcome text check (outcome in ('resolved', 'escalated', 'awaiting_customer', 'closed_no_reply', 'error')),
  confidence numeric(3, 2),
  steps integer not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  est_cost_usd numeric(10, 6) not null default 0,
  latency_ms integer,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (tenant_id, ticket_id) references public.tickets (tenant_id, id) on delete cascade
);
create index agent_runs_ticket_idx on public.agent_runs (tenant_id, ticket_id, started_at desc);
create index agent_runs_time_idx on public.agent_runs (tenant_id, started_at desc);

create table public.trace_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  run_id uuid not null references public.agent_runs (id) on delete cascade,
  seq integer not null,
  type public.trace_event_type not null,
  name text not null,
  input jsonb,
  output jsonb,
  latency_ms integer,
  tokens_in integer,
  tokens_out integer,
  created_at timestamptz not null default now()
);
create index trace_events_run_idx on public.trace_events (run_id, seq);

create table public.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  actor_type public.actor_type not null,
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_idx on public.audit_log (tenant_id, created_at desc);

-- Daily usage per provider/model for free-tier tracking (global, not tenant data).
create table public.usage_daily (
  day date not null default current_date,
  provider text not null,
  metric text not null, -- requests | tokens_in | tokens_out | emails_sent | ...
  value bigint not null default 0,
  primary key (day, provider, metric)
);

-- Fixed-window rate limiting buckets (per sender / IP / global).
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- Channel cursor state (e.g. Gmail historyId). Secrets are NOT stored here.
create table public.channel_state (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  channel public.channel_type not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, channel)
);

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid,
  verified_customer_id uuid,
  verification_attempts integer not null default 0,
  ip_hash text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Knowledge base (RAG): documents + 768-dim chunk embeddings + full-text
-- ---------------------------------------------------------------------------
create table public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  slug text not null,
  title text not null,
  content text not null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug),
  unique (tenant_id, id)
);

create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  document_id uuid not null,
  chunk_index integer not null,
  content text not null,
  embedding extensions.vector(768),
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  unique (document_id, chunk_index),
  foreign key (tenant_id, document_id) references public.kb_documents (tenant_id, id) on delete cascade
);
create index kb_chunks_tenant_idx on public.kb_chunks (tenant_id);
create index kb_chunks_fts_idx on public.kb_chunks using gin (fts);
create index kb_chunks_embedding_idx on public.kb_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- Hybrid retrieval (vector + keyword) fused with Reciprocal Rank Fusion.
-- Tenant is a required parameter: retrieval can never cross tenants.
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
as $$
  with semantic as (
    select c.id, row_number() over (order by c.embedding <=> p_query_embedding) as rank,
           1 - (c.embedding <=> p_query_embedding) as similarity
    from kb_chunks c
    where c.tenant_id = p_tenant_id and c.embedding is not null
    order by c.embedding <=> p_query_embedding
    limit 20
  ),
  -- Keyword leg: stemmed query terms OR-ed together ("return sale items" → return | sale | item),
  -- ranked by cover density so chunks matching more terms close together rank higher.
  query as (
    select to_tsquery('english', string_agg(quote_literal(lexeme), ' | ')) as q
    from unnest(to_tsvector('english', p_query_text))
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
  select c.id, c.document_id, d.title, d.slug, c.content, coalesce(f.similarity, 0), f.score
  from fused f
  join kb_chunks c on c.id = f.id
  join kb_documents d on d.id = c.document_id and d.tenant_id = p_tenant_id
  order by f.score desc
  limit least(greatest(p_match_count, 1), 10);
$$;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tenant_settings_touch before update on public.tenant_settings
  for each row execute function public.touch_updated_at();
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();
create trigger tickets_touch before update on public.tickets
  for each row execute function public.touch_updated_at();
create trigger kb_documents_touch before update on public.kb_documents
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- Membership checks run as definer so policies don't recurse through tenant_members' own RLS.
create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.has_tenant_role(p_tenant_id uuid, p_roles public.member_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid()) and m.role = any (p_roles)
  );
$$;

revoke all on function public.is_tenant_member(uuid) from public, anon;
revoke all on function public.has_tenant_role(uuid, public.member_role[]) from public, anon;
grant execute on function public.is_tenant_member(uuid) to authenticated, service_role;
grant execute on function public.has_tenant_role(uuid, public.member_role[]) to authenticated, service_role;
revoke all on function public.match_kb_chunks(uuid, extensions.vector, text, integer) from public, anon, authenticated;
grant execute on function public.match_kb_chunks(uuid, extensions.vector, text, integer) to service_role;

-- Enable RLS everywhere. Tables without a policy for a role are fully denied to that role.
do $$
declare t text;
begin
  foreach t in array array[
    'tenants', 'tenant_settings', 'tenant_members', 'customers', 'orders', 'payments', 'tickets',
    'messages', 'processed_messages', 'refunds', 'escalations', 'agent_runs', 'trace_events',
    'audit_log', 'usage_daily', 'rate_limits', 'channel_state', 'chat_sessions', 'kb_documents',
    'kb_chunks'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Read access for tenant members (dashboard). Anonymous users get nothing.
do $$
declare t text;
begin
  foreach t in array array[
    'tenant_settings', 'customers', 'orders', 'payments', 'tickets', 'messages', 'refunds',
    'escalations', 'agent_runs', 'trace_events', 'audit_log', 'kb_documents', 'channel_state'
  ] loop
    execute format(
      'create policy member_read on public.%I for select to authenticated using (public.is_tenant_member(tenant_id))',
      t
    );
  end loop;
end $$;

create policy member_read on public.tenants for select to authenticated
  using (public.is_tenant_member(id));
create policy self_read on public.tenant_members for select to authenticated
  using (user_id = (select auth.uid()));

-- Writes from the dashboard are narrow: owners change settings; agents act on escalations/tickets.
create policy owner_update on public.tenant_settings for update to authenticated
  using (public.has_tenant_role(tenant_id, array['owner']::public.member_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner']::public.member_role[]));
create policy agent_update on public.escalations for update to authenticated
  using (public.has_tenant_role(tenant_id, array['owner', 'agent']::public.member_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner', 'agent']::public.member_role[]));
create policy agent_update on public.tickets for update to authenticated
  using (public.has_tenant_role(tenant_id, array['owner', 'agent']::public.member_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner', 'agent']::public.member_role[]));

-- The anon role never touches tables directly; the public chat goes through server routes.
revoke all on all tables in schema public from anon;
