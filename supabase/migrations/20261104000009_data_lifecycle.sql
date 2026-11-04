-- =============================================================================
-- Data lifecycle (spec: "auto-delete old messages after a set period"; privacy page: up to N days)
--
-- purge_expired_data() — per tenant, deletes finished tickets (resolved/closed/spam, nothing
--   pending) whose last activity is older than tenant_settings.retention_days. Messages, agent runs, trace events and escalations cascade.
--   Refunds keep their financial record (ticket_id is set null). Also removes:
--     * chat sessions idle for 7 days (they hold an IP hash),
--     * processed-message ids 30 days past retention (ids only; kept longer than the tickets so
--       a late Gmail re-delivery can't be processed twice),
--     * audit entries older than 365 days (audit needs a longer window than conversations; it
--       stores actions and order numbers, not message text).
--   Returns counts so each run is visible in the cron history.
--
-- Scheduled with pg_cron where available (Supabase); the test database (PGlite) has no pg_cron.
-- =============================================================================

-- Fictional demo tenants (set from tenants/<slug>/tenant.json "demo": true). reset_demo_data()
-- checks this flag in SQL, so its daily reset can never touch a real client's records.
alter table public.tenants add column if not exists is_demo boolean not null default false;

create or replace function public.purge_expired_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_tickets integer;
  n_sessions integer;
  n_processed integer;
  n_audit integer;
begin
  -- Only finished conversations: open, escalated or needs-attention tickets wait for a human no
  -- matter how old. Age is the latest of the ticket's own update and its newest message, because
  -- a follow-up message doesn't touch tickets.updated_at.
  delete from public.tickets t
  using public.tenant_settings s
  where s.tenant_id = t.tenant_id
    and (t.status in ('resolved', 'closed') or t.is_spam)
    and greatest(
          t.updated_at,
          coalesce((select max(m.created_at) from public.messages m
                    where m.tenant_id = t.tenant_id and m.ticket_id = t.id), t.updated_at)
        ) < now() - make_interval(days => s.retention_days)
    and not exists (select 1 from public.escalations e
                    where e.tenant_id = t.tenant_id and e.ticket_id = t.id and e.status = 'pending')
    and not exists (select 1 from public.refunds r
                    where r.tenant_id = t.tenant_id and r.ticket_id = t.id and r.status = 'pending_approval');
  get diagnostics n_tickets = row_count;

  delete from public.chat_sessions where last_seen_at < now() - interval '7 days';
  get diagnostics n_sessions = row_count;

  delete from public.processed_messages p
  using public.tenant_settings s
  where s.tenant_id = p.tenant_id
    and p.processed_at < now() - make_interval(days => s.retention_days + 30);
  get diagnostics n_processed = row_count;

  delete from public.audit_log where created_at < now() - interval '365 days';
  get diagnostics n_audit = row_count;

  return jsonb_build_object(
    'tickets', n_tickets, 'chat_sessions', n_sessions,
    'processed_messages', n_processed, 'audit_log', n_audit
  );
end;
$$;

revoke all on function public.purge_expired_data() from public, anon, authenticated;
grant execute on function public.purge_expired_data() to service_role;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- cron.schedule with an existing job name replaces it, so re-running is safe.
    perform cron.schedule('purge-expired-data', '17 3 * * *', 'select public.purge_expired_data()');
    perform cron.schedule('prune-rate-limits', '7 * * * *', 'select public.prune_rate_limits()');
    -- reset_demo_data() is (re)defined by supabase/seed.sql; until the seed has run, this no-ops.
    perform cron.schedule(
      'reset-demo-data', '0 6 * * *',
      $job$do $d$ begin
        if to_regproc('public.reset_demo_data') is not null then
          execute 'select public.reset_demo_data()';
        end if;
      end $d$ $job$
    );
  end if;
end;
$cron$;
