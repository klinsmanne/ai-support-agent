# Progress

_Last updated: 2026-11-05_

## Done

- **Step 0 — Machine setup:** Git, Node 26, npm, GitHub CLI, Vercel CLI, Supabase CLI, gcloud CLI (macOS, Apple Silicon).
- **Accounts:** GitHub `klinsmanne` (commits use the no-reply address) · Supabase (project `ai-support-agent`, ref `uhjaivpcizzgwvozaojp`) · Google Cloud project `ai-support-agent-261103` on personal account ivklinsy@gmail.com (Gemini, API Keys and Gmail APIs enabled; the school Google account blocks Google Cloud) · Groq.
- **Secrets** live in the macOS Keychain (`npm run secrets status`): Supabase URL/publishable/secret keys, Gemini key (restricted to the Gemini API), Groq key, CRON_SECRET, CSRF_SECRET. DB password: Keychain service `supabase-db-password`.
- **Milestone A — Project setup (PR #1, merged).**
- **Milestone B — Discovery + solution design (PR #7, merged).**
- **Milestone C — Database (PR #8, merged):** 20 tables, RLS everywhere, dashboard read-only at DB level, composite tenant FKs, hybrid pgvector + full-text retrieval, config-driven tenants, generated idempotent seed. Live in Supabase; KB embedded (29 chunks, gemini-embedding-2 @768d).

- **Milestone D — Agent (PR #9, merged).**
- **Milestone E — Channels (PR #10, merged):** Gmail + chat pipeline, DMARC-aligned sender auth, at-most-once processing.
- **Milestone G — Landing page (PR #12, merged).**
- **Milestone J — Production deploy + E2E (PRs #15–#16, merged):** live at https://ai-support-ops-agent.vercel.app; pg_cron Gmail polling with lease; published Gmail app; Turnstile; post-deploy smoke tests (ADR-024).
- **Milestone I — Evals + model comparison (PR #14, merged):** 47-case suite, LLM judge, CI gate; Flash-Lite 98% / gpt-oss-20b 96%, 0 safety failures → production chain (ADR-022); claimed-action guardrail (ADR-023).
- **Milestone H — Hardening (PR #13, merged):** data lifecycle (pg_cron), no-training email providers, Turnstile + CSP, failure alerts, THREAT_MODEL.
- **Milestone F — Dashboard (PR #11, merged):** invite-only sign-in, read-only public demo (viewer privacy in RLS), trace view, approvals that execute the pending action first, settings + kill switch, KPI metrics.
- **Gmail:** support inbox `integralplantsupport@gmail.com` connected; OAuth app published (refresh token doesn't expire).

## In progress (resume here)

- **Final docs (PR open):** README, ONBOARDING_RUNBOOK, HANDOFF, CASE_STUDY, DEMO_SCRIPT (2/5/15 min), INTERVIEW_PREP, CHANNEL_ADAPTERS, WHAT_I_LEARNED, BEYOND_THE_SPEC, FINAL_CHECKLIST, 4 beginner guides; 5 new project commands; scoped dashboard invites (ADR-025); live-test fixes (Groq JSON-generation fallback, injection reason kept when triage fails). Live tests 2026-11-05: normal, angry + refund, injection, second tenant, email — all pass (see docs/FINAL_CHECKLIST.md).
- **Open:** Gemini Flash (15-case sample) + gpt-oss-120b eval results (free quota; `npm run eval:report` + small commit); second alert channel; Dependabot PRs #2–#6.

## Next

- Merge the final-docs PR; add the pending eval results when the free-quota runs finish
- Optional: second alert channel; record the 2-minute demo video (docs/DEMO_SCRIPT.md)
- Dependabot PRs #2–#6 (TypeScript 7 and ESLint 10 are majors — test before merging)

## Known issues

- Free-tier latency: measured p50 model time 2.2 s (20b) / 4.0 s (Flash-Lite); free-tier rate-limit waits come on top.
- Retrieval recall gap: "my package never arrived" doesn't surface "Delayed shipments" (vocabulary mismatch). Measure in evals; consider query rewriting.
- gcloud is not on the default PATH; use `/opt/homebrew/share/google-cloud-sdk/bin/gcloud`.

## Resume in a fresh session

Paste this into a new Claude Code session opened in this folder:

> Resume the AI support agent project. Read CLAUDE.md and PROGRESS.md, run `git status` and `gh pr list`, then continue with the next milestone in PROGRESS.md. I'm a beginner — keep guiding me one step at a time.

## Decisions

See `docs/DECISIONS.md` (ADR-001 … ADR-025).
