---
description: Check free-tier usage, the live site's health and the Gmail poll job
---

Report the health of the live system in plain language. Read-only: change nothing.

1. `curl -s https://ai-support-ops-agent.vercel.app/api/health`: ok and deployed commit.
2. Gmail poll: `supabase db query --remote --read-only "select created, status_code, left(content::text, 200) from net._http_response order by created desc limit 5"`. Explain any non-200 or `error` field.
3. Model usage today: `supabase db query --remote --read-only "select provider, metric, value from public.usage_daily where day = current_date order by provider, metric"`, compared against the free-tier limits in `docs/research/FREE_TIER_RESEARCH.md`. Warn at 80% or more.
4. Tickets needing attention: `select count(*) from public.tickets where status = 'needs_attention'`.
5. Summarize in 3–5 bullets with anything the user should act on. Never print secrets.
