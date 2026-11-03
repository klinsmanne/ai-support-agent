# Progress

_Last updated: 2026-11-03_

## Done

- **Step 0 — Machine setup:** Git, Node 26, npm, GitHub CLI, Vercel CLI, Supabase CLI, gcloud CLI (macOS, Apple Silicon).
- **Accounts:** GitHub `klinsmanne` (commits use the no-reply address) · Supabase (project `ai-support-agent`, ref `uhjaivpcizzgwvozaojp`) · Google Cloud project `ai-support-agent-261103` on personal account ivklinsy@gmail.com (Gemini, API Keys and Gmail APIs enabled; the school Google account blocks Google Cloud) · Groq.
- **Secrets** live in the macOS Keychain (`npm run secrets status`): Supabase URL/publishable/secret keys, Gemini key (restricted to the Gemini API), Groq key, CRON_SECRET, CSRF_SECRET. DB password: Keychain service `supabase-db-password`.
- **Milestone A — Project setup (PR #1, merged).**
- **Milestone B — Discovery + solution design (PR #7, merged).**
- **Milestone C — Database (PR #8, merged):** 20 tables, RLS everywhere, dashboard read-only at DB level, composite tenant FKs, hybrid pgvector + full-text retrieval, config-driven tenants, generated idempotent seed. Live in Supabase; KB embedded (29 chunks, gemini-embedding-2 @768d).

- **Milestone D — Agent (PR #9, merged).**
- **Gmail:** support inbox `integralplantsupport@gmail.com` connected (OAuth app in Testing mode; refresh token in Keychain — expires after 7 days until the app is published, which needs a live homepage + privacy URL).

## In progress (resume here)

- **Milestone E — Channels (branch `milestone/e-channels`, not yet a PR):** Gmail client + poller (`npm run email:poll`, verified live), shared ticket pipeline (dedupe, loop filters, sender verification, threading, rate limits, rollout modes, audit), chat API + widget (signed sessions, order+email verification). 197 tests pass.
- **Blocking issue found in live chat test:** Gemini free _daily_ quotas were exhausted by today's testing; the router treated them as per-minute limits (waited 8 s), then the 45 s budget ran out before Groq was tried. **Next fix:** in `src/lib/llm/router.ts` + `gemini.ts`, detect daily-quota 429s (quotaId contains `PerDay`) → long cool-down (hours) and no wait; only wait when a retry hint exists; consider putting Groq earlier in the agent chain and spreading across more Groq models (gpt-oss-20b, qwen). Then re-test chat at http://localhost:3000 and a live email from a personal address.
- Then: open PR for milestone E (run security + quality review subagents first), schedule pg_cron polling at deploy time.

## Previously in progress

- **Milestone D — Agent (PR #9):** provider layer (Gemini/Groq/Claude-ready, fallback chain, circuit breaker, rate-limit waits), agent loop, 8 least-privilege tools, policy engine, guardrails, MemoryRepo + SupabaseRepo. 130 tests; all 10 spec scenarios pass live. Awaiting subagent reviews → fix → merge.

## Next

- Milestone E — Channels: email pipeline (Gmail OAuth, poll via pg_cron, filters/dedupe/threading, SPF/DKIM/DMARC) + chat widget (verification, Turnstile)
- Milestone F — Dashboard · G — Landing page · H — Hardening + THREAT_MODEL · I — Evals + model comparison · J — Production deploy
- Accounts still needed: Vercel, Cloudflare (Turnstile), new support Gmail inbox
- Live DB: Harbor & Pine `escalate_on_negative_sentiment_below` must be updated to −0.85 (seed never overwrites settings)
- Dependabot PRs #2–#6 (TypeScript 7 and ESLint 10 are majors — test before merging)

## Known issues

- Free-tier latency: 503s / rate limits on Gemini 3.8/3.7 add 3–40 s per ticket; chain + waits keep it working. Measure in evals.
- Retrieval recall gap: "my package never arrived" doesn't surface "Delayed shipments" (vocabulary mismatch). Measure in evals; consider query rewriting.
- gcloud is not on the default PATH; use `/opt/homebrew/share/google-cloud-sdk/bin/gcloud`.

## Resume in a fresh session

Paste this into a new Claude Code session opened in this folder:

> Resume the AI support agent project. Read CLAUDE.md and PROGRESS.md, run `git status` and `gh pr list`, then continue with the next milestone in PROGRESS.md. I'm a beginner — keep guiding me one step at a time.

## Decisions

See `docs/DECISIONS.md` (ADR-001 … ADR-011).
