# Progress

_Last updated: 2026-11-03_

## Done

- **Step 0 — Machine setup:** Git, Node 26, npm, GitHub CLI, Vercel CLI, Supabase CLI, gcloud CLI installed and verified (macOS, Apple Silicon).
- **GitHub:** CLI logged in as `klinsmanne`; commits use the GitHub no-reply address.

- **Milestone A — Project setup (PR #1, merged):** Next.js 16 scaffold, Prettier/Vitest/Zod, CLAUDE.md, `.claude/settings.json` (permissions + hooks with tests), CI (lint, types, format, tests, build, gitleaks, npm audit), Dependabot. Reviewed by security + quality subagents; all findings fixed.
- **Supabase:** CLI logged in; project `ai-support-agent` (ref `uhjaivpcizzgwvozaojp`, us-east-1) created. DB password is in macOS Keychain (service `supabase-db-password`).

- **Milestone B — Discovery + solution design (PR #7, merged).**

## In progress

- **Milestone C — Database (PR #8):** schema (20 tables), RLS everywhere, dashboard read-only at DB level (writes via validated server routes), composite tenant FKs, hybrid pgvector + full-text retrieval, config-driven tenants (`tenants/<slug>/`), generated idempotent seed, Keychain secrets helper (`npm run secrets`). Applied to Supabase; 57 tests pass. Security + quality review findings fixed (migration `..._harden_grants.sql`).

## Next

- Gemini API key (needs user's Google sign-in) → embed KB (`kb:embed`)
- Milestone D — Agent loop, tools, guardrails, provider abstraction (Gemini/Groq/Claude)
- Accounts still needed: Google AI Studio, Groq, Vercel, support Gmail
- Dependabot PRs #2–#6 (TypeScript 7 and ESLint 10 are majors — test before merging)

## Known issues

- gcloud is not on the default shell PATH (`/opt/homebrew/share/google-cloud-sdk/bin`); Claude uses the full path.

## Decisions

See `docs/DECISIONS.md`.
