-- Escalation notifications (ADR-027). Escalations used to wait silently in the dashboard queue;
-- now each client can name a team address that gets (1) an instant email for urgent escalations
-- and (2) a daily digest of everything still waiting.

alter table public.tenant_settings
  add column if not exists escalation_notify_email text
    check (escalation_notify_email is null or escalation_notify_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column if not exists escalation_digest boolean not null default true;

-- Daily digest at 13:00 UTC (8 am US Central), through the app's digest endpoint with the same
-- CRON_SECRET as the Gmail poll. The URL is derived from the poll URL in Vault, so no new secret.
create or replace function public.trigger_escalation_digest()
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
  perform net.http_post(
    url := replace(poll_url, '/api/channels/gmail/poll', '/api/cron/escalation-digest'),
    headers := jsonb_build_object(
      'authorization', 'Bearer ' || secret,
      'content-type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

revoke all on function public.trigger_escalation_digest() from public, anon, authenticated, service_role;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('escalation-digest', '0 13 * * *', $job$ select public.trigger_escalation_digest(); $job$);
  end if;
end
$cron$;
