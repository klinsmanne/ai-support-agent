-- One Gmail poll at a time (code-quality review, milestone J). pg_cron starts a poll every
-- 2 minutes, but a poll can run up to the endpoint's 300 s limit. Two overlapping polls would both
-- read the same cursor and retry queue and the slower one would overwrite the other's progress.
-- A poll now claims a lease atomically first; a poll that finds an unexpired lease does nothing.
-- A crashed poll's lease simply expires.

alter table public.channel_state add column if not exists lease_until timestamptz;

create or replace function public.claim_channel_lease(
  p_tenant_id uuid,
  p_channel public.channel_type,
  p_seconds integer
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    insert into public.channel_state (tenant_id, channel, lease_until)
    values (p_tenant_id, p_channel, now() + make_interval(secs => p_seconds))
    on conflict (tenant_id, channel) do update
      set lease_until = excluded.lease_until
      where public.channel_state.lease_until is null
         or public.channel_state.lease_until < now()
    returning 1
  )
  select exists (select 1 from claimed);
$$;

create or replace function public.release_channel_lease(
  p_tenant_id uuid,
  p_channel public.channel_type
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.channel_state set lease_until = null
  where tenant_id = p_tenant_id and channel = p_channel;
$$;

-- Server-only: the poll endpoint uses the service role; browsers never call these.
revoke all on function public.claim_channel_lease(uuid, public.channel_type, integer)
  from public, anon, authenticated;
revoke all on function public.release_channel_lease(uuid, public.channel_type)
  from public, anon, authenticated;
grant execute on function public.claim_channel_lease(uuid, public.channel_type, integer) to service_role;
grant execute on function public.release_channel_lease(uuid, public.channel_type) to service_role;

-- Replaces migration 11's version (its comment wrongly said the endpoint guarded overlaps, and its
-- 60 s timeout was shorter than the endpoint's 300 s). Privileges are kept by create or replace,
-- and revoked again to be explicit.
create or replace function public.trigger_gmail_poll()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  poll_url text;
  secret text;
begin
  select decrypted_secret into poll_url from vault.decrypted_secrets where name = 'gmail_poll_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret';
  if poll_url is null or secret is null then
    return; -- not configured in this environment
  end if;
  -- Fire-and-forget: pg_net sends asynchronously. The lease above prevents overlapping polls,
  -- and the timeout matches the endpoint's 300 s limit, so a long poll isn't logged as a timeout.
  perform net.http_post(
    url := poll_url,
    headers := jsonb_build_object(
      'authorization', 'Bearer ' || secret,
      'content-type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
end;
$$;

revoke all on function public.trigger_gmail_poll() from public, anon, authenticated, service_role;
