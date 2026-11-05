-- Production Gmail polling (ADR-024): pg_cron calls the app's poll endpoint every 2 minutes.
-- Vercel Hobby crons run at most once a day, so the schedule lives in the database, next to the
-- other lifecycle jobs (ADR-019). The calls also keep the free Supabase project from pausing.
--
-- The endpoint URL and CRON_SECRET live in Supabase Vault (encrypted, never in git). They are
-- written by `npm run secrets push-supabase-vault`. Without them the job does nothing, so
-- local and test databases are unaffected.

do $ext$
begin
  -- PGlite (unit tests) and some local setups don't ship pg_net.
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end
$ext$;

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
  -- Fire-and-forget: pg_net sends asynchronously, and the endpoint itself guards against
  -- overlapping runs (ADR-017), so a slow poll can't pile up work.
  perform net.http_post(
    url := poll_url,
    headers := jsonb_build_object(
      'authorization', 'Bearer ' || secret,
      'content-type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

-- Only pg_cron (postgres) may trigger polls; Supabase's default privileges would otherwise grant
-- new functions to the API roles, including service_role (lesson from migration 10).
revoke all on function public.trigger_gmail_poll() from public, anon, authenticated, service_role;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('poll-gmail', '*/2 * * * *', $job$ select public.trigger_gmail_poll(); $job$);
  end if;
end
$cron$;
