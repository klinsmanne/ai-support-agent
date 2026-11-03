-- =============================================================================
-- Pipeline helpers: atomic rate limiting, free-tier usage counters, ticket counts.
-- All are service-role only (the backend), never callable from the browser.
-- =============================================================================

-- Fixed-window counter; returns true if the call is allowed (count after increment <= max).
create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits (key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set count = public.rate_limits.count + 1
  returning count into v_count;
  return v_count <= p_max;
end;
$$;

create or replace function public.usage_add(p_provider text, p_metric text, p_value bigint)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.usage_daily (day, provider, metric, value)
  values (current_date, p_provider, p_metric, p_value)
  on conflict (day, provider, metric) do update set value = public.usage_daily.value + excluded.value;
$$;

-- Housekeeping: old rate-limit windows are useless after a day.
create or replace function public.prune_rate_limits()
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.rate_limits where window_start < now() - interval '1 day';
$$;

-- Processing status on the idempotency ledger, so failures are visible and retryable.
alter table public.processed_messages
  add column status text not null default 'processing' check (status in ('processing', 'done', 'skipped', 'failed')),
  add column attempts integer not null default 1,
  add column last_error text;

create index tickets_created_idx on public.tickets (tenant_id, created_at desc);
create index messages_pending_idx on public.messages (tenant_id, status) where status in ('pending_approval', 'draft');

revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.usage_add(text, text, bigint) from public, anon, authenticated;
revoke all on function public.prune_rate_limits() from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
grant execute on function public.usage_add(text, text, bigint) to service_role;
grant execute on function public.prune_rate_limits() to service_role;
