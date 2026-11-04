-- =============================================================================
-- Processing ledger hardening (milestone E reviews):
-- - updated_at lets a sweeper find runs that crashed mid-way ("processing" forever) and hand
--   their tickets to a human instead of losing them;
-- - failed messages are no longer retried automatically (a re-run could send a second reply),
--   so the `attempts` column is informational only.
-- =============================================================================

alter table public.processed_messages add column updated_at timestamptz not null default now();

create trigger processed_messages_touch before update on public.processed_messages
  for each row execute function public.touch_updated_at();

create index processed_messages_status_idx on public.processed_messages (status, updated_at)
  where status = 'processing';
