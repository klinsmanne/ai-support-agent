# Progress

_Last updated: 2026-11-04_

## Done

- **Step 0 — Machine setup:** Git, Node 26, npm, GitHub CLI, Vercel CLI, Supabase CLI, gcloud CLI (macOS, Apple Silicon).
- **Accounts:** GitHub `klinsmanne` (commits use the no-reply address) · Supabase (project `ai-support-agent`, ref `uhjaivpcizzgwvozaojp`) · Google Cloud project `ai-support-agent-261103` on personal account ivklinsy@gmail.com (Gemini, API Keys and Gmail APIs enabled; the school Google account blocks Google Cloud) · Groq.
- **Secrets** live in the macOS Keychain (`npm run secrets status`): Supabase URL/publishable/secret keys, Gemini key (restricted to the Gemini API), Groq key, CRON_SECRET, CSRF_SECRET. DB password: Keychain service `supabase-db-password`.
- **Milestone A — Project setup (PR #1, merged).**
- **Milestone B — Discovery + solution design (PR #7, merged).**
- **Milestone C — Database (PR #8, merged):** 20 tables, RLS everywhere, dashboard read-only at DB level, composite tenant FKs, hybrid pgvector + full-text retrieval, config-driven tenants, generated idempotent seed. Live in Supabase; KB embedded (29 chunks, gemini-embedding-2 @768d).

- **Milestone D — Agent (PR #9, merged).**
- **Milestone E — Channels (PR #10, merged):** Gmail + chat pipeline, DMARC-aligned sender auth, at-most-once processing.
- **Milestone F — Dashboard (PR #11, merged):** invite-only sign-in, read-only public demo (viewer privacy in RLS), trace view, approvals that execute the pending action first, settings + kill switch, KPI metrics.
- **Gmail:** support inbox `integralplantsupport@gmail.com` connected (OAuth app in Testing mode; refresh token in Keychain — expires after 7 days until the app is published, which needs a live homepage + privacy URL).

## In progress (resume here)

- **Milestone G — Landing page (PR #12):** problem → how it works (architecture, resolve vs escalate) → try it (scenario buttons prefill the chat; demo-email buttons for both tenants) → live aggregate numbers (demo tenants only, cached per minute) → privacy note; `/privacy` and `/terms` for the Gmail OAuth app. Security + quality review findings fixed. 235 tests. → merge after CI.
- Then **Milestone H — Hardening + THREAT_MODEL.** Must-dos carried from the G review:
  - **Retention purge** (`purge_expired()` deleting tickets/messages/traces older than `tenants.retention_days`, scheduled with pg_cron) — the privacy page promises "up to 90 days"; ship before the site goes public in J.
  - **Email content only to no-training providers** (Groq), then restore a Google API "Limited Use" statement on `/privacy`.
  - Schedule `prune_rate_limits()`; nonce-based CSP `script-src`; daily demo-data reset (shared demo refunds/address changes wear out); eval that "this is ridiculous" + duplicate charge still refunds.

## Previously in progress

- **Milestone D — Agent (PR #9):** provider layer (Gemini/Groq/Claude-ready, fallback chain, circuit breaker, rate-limit waits), agent loop, 8 least-privilege tools, policy engine, guardrails, MemoryRepo + SupabaseRepo. 130 tests; all 10 spec scenarios pass live. Awaiting subagent reviews → fix → merge.

## Next

- Milestone E — Channels: email pipeline (Gmail OAuth, poll via pg_cron, filters/dedupe/threading, SPF/DKIM/DMARC) + chat widget (verification, Turnstile)
- H — Hardening + THREAT_MODEL · I — Evals + model comparison · J — Production deploy
- Accounts still needed: Vercel, Cloudflare (Turnstile), new support Gmail inbox
- Dependabot PRs #2–#6 (TypeScript 7 and ESLint 10 are majors — test before merging)

## Known issues

- Free-tier latency: 503s / rate limits on Gemini 3.8/3.7 add 3–40 s per ticket; chain + waits keep it working. Measure in evals.
- Retrieval recall gap: "my package never arrived" doesn't surface "Delayed shipments" (vocabulary mismatch). Measure in evals; consider query rewriting.
- gcloud is not on the default PATH; use `/opt/homebrew/share/google-cloud-sdk/bin/gcloud`.

## Resume in a fresh session

Paste this into a new Claude Code session opened in this folder:

> Resume the AI support agent project. Read CLAUDE.md and PROGRESS.md, run `git status` and `gh pr list`, then continue with the next milestone in PROGRESS.md. I'm a beginner — keep guiding me one step at a time.

## Decisions

See `docs/DECISIONS.md` (ADR-001 … ADR-018).
