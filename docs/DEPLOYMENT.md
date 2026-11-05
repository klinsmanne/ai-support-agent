# Deployment (production)

Live: **https://ai-support-ops-agent.vercel.app** · all free tiers, no credit card (ADR-024).

## What runs where

| Piece                        | Where                                                  | Notes                                                                                                                     |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Web app, chat API, dashboard | Vercel Hobby (project `ai-support-agent`)              | Deploys from GitHub: every merge to `main` → production; PRs → login-protected previews                                   |
| Database, auth, RLS          | Supabase free (`uhjaivpcizzgwvozaojp`)                 | Migrations in `supabase/migrations/`, seed generated from `tenants/*`                                                     |
| Gmail polling                | Supabase pg_cron `poll-gmail`, every 2 min             | pg_net POSTs to `/api/channels/gmail/poll` with `CRON_SECRET` from Supabase Vault                                         |
| Escalation digest            | Supabase pg_cron `escalation-digest`, daily 13:00 UTC  | POSTs to `/api/cron/escalation-digest` with `CRON_SECRET`; urgent escalations email instantly from the pipeline (ADR-027) |
| Data lifecycle               | Supabase pg_cron (purge, demo reset, pruning)          | ADR-019                                                                                                                   |
| Bot check for chat           | Cloudflare Turnstile (widget for the live host)        | Fails closed in production (ADR-021)                                                                                      |
| Email                        | Gmail API, OAuth app **in production**                 | Refresh token doesn't expire; Limited Use statement on `/privacy`                                                         |
| Failure alerts               | Email (`ALERT_EMAIL`) + ntfy push (`ALERT_NTFY_TOPIC`) | 3+ failures of a kind in an hour; at most one alert an hour per kind (ADR-026)                                            |
| Post-deploy smoke tests      | GitHub Actions `e2e.yml`                               | After each push to `main`, waits until `/api/health` reports that commit, then runs `npm run e2e`; also daily             |

The pg_cron poll also keeps the free Supabase project from pausing for inactivity. A lease (migration 12) lets only one poll run at a time, since a poll can take up to the endpoint's 300 s limit.

## Secrets

Source of truth is the macOS Keychain (`npm run secrets status`). Production copies:

- **Vercel:** `npm run secrets push-vercel production`. It never sends development-only values (Cloudflare's Turnstile test keys, localhost URLs). `APP_URL` and the real Turnstile keys are set only in Vercel, because local development uses localhost and the test keys.
- **Supabase Vault:** `npm run secrets push-supabase-vault https://ai-support-ops-agent.vercel.app/api/channels/gmail/poll` stores `cron_secret` and `gmail_poll_url` for the poll job. Values go through stdin only.

After changing a Vercel variable, redeploy (`vercel deploy --prod`, or merge to `main`).

## Repeat the setup (new client or new environment)

1. `vercel link`, `vercel git connect`, and give the Vercel GitHub app access to the repo.
2. `npm run secrets push-vercel production`, then `vercel env add APP_URL production` (and the Turnstile keys for the live hostname).
3. Supabase: set `site_url` and `additional_redirect_urls` in `supabase/config.toml`, then run `supabase config push` (it shows a diff first). Then run `supabase db push --remote` and `npm run secrets push-supabase-vault <poll URL>`.
4. Gmail: the OAuth app's Branding page (home page, `/privacy`, `/terms`, authorized domain) → Audience → Publish. Then `npm run gmail:auth` once more for a non-expiring token, and push it to Vercel.
5. `npm run e2e` against the new URL.

## Rollback

- **App:** Vercel dashboard → Deployments → previous production deployment → "Promote to Production" (instant). Or revert the merge on `main`.
- **Inbox processing:** `select cron.unschedule('poll-gmail');` stops polling (re-run migration 11's `cron.schedule` to restart). The dashboard kill switch stops the agent while keeping tickets flowing to humans.
- **Database:** migrations only add things (tables, functions, jobs); undo one with a new migration rather than editing an applied file.

## Checks

- `curl https://ai-support-ops-agent.vercel.app/api/health`
- Last poll results: `select status_code, content from net._http_response order by created desc limit 5;`
- Cron runs: `select * from cron.job_run_details order by start_time desc limit 10;`
