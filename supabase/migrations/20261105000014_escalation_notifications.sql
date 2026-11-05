-- Escalation notifications (ADR-027). Escalations used to wait silently in the dashboard queue;
-- now each client can name a team address that gets (1) an instant email for urgent escalations
-- and (2) a daily digest of everything still waiting.

alter table public.tenant_settings
  add column if not exists escalation_notify_email text
    check (escalation_notify_email is null or escalation_notify_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column if not exists escalation_digest boolean not null default true;

-- The team address is readable only by the server (service role), not by signed-in dashboard
-- users: the public demo account is a member too. Table-level SELECT would include every column,
-- so authenticated gets an explicit column list without it (RLS still applies row by row).
revoke select on public.tenant_settings from authenticated;
grant select (
  tenant_id, rollout_mode, kill_switch, refund_auto_approve_limit_cents,
  max_refunds_per_customer_30d, escalate_on_negative_sentiment_below, min_confidence_to_act,
  enabled_tools, brand_name, brand_voice, supported_languages, allowed_link_domains,
  support_email, csat_enabled, daily_ticket_cap, max_ai_replies_per_thread, retention_days,
  updated_at, escalation_digest
) on public.tenant_settings to authenticated;

-- Daily digest at 13:00 UTC (7 am US Central in winter, 8 am in summer), through the app's digest endpoint with the same
-- CRON_SECRET as the Gmail poll. The URL is derived from the poll URL in Vault, so no new secret.
create or replace function public.trigger_escalation_digest()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  poll_url text;
  digest_url text;
  secret text;
begin
  select decrypted_secret into poll_url from vault.decrypted_secrets where name = 'gmail_poll_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret';
  if poll_url is null or secret is null then
    return; -- not configured in this environment
  end if;
  digest_url := replace(poll_url, '/api/channels/gmail/poll', '/api/cron/escalation-digest');
  if digest_url = poll_url then
    return; -- unexpected poll URL shape: don't call the wrong endpoint
  end if;
  perform net.http_post(
    url := digest_url,
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
