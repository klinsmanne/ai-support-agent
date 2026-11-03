# Progress

_Last updated: 2026-11-03_

## Done

- **Step 0 — Machine setup:** Git, Node 26, npm, GitHub CLI, Vercel CLI, Supabase CLI, gcloud CLI installed and verified (macOS, Apple Silicon).
- **GitHub:** CLI logged in as `klinsmanne`; commits use the GitHub no-reply address.

- **Milestone A — Project setup (PR #1, merged):** Next.js 16 scaffold, Prettier/Vitest/Zod, CLAUDE.md, `.claude/settings.json` (permissions + hooks with tests), CI (lint, types, format, tests, build, gitleaks, npm audit), Dependabot. Reviewed by security + quality subagents; all findings fixed.
- **Supabase:** CLI logged in; project `ai-support-agent` (ref `uhjaivpcizzgwvozaojp`, us-east-1) created. DB password is in macOS Keychain (service `supabase-db-password`).

## In progress

- **Milestone B — Discovery + solution design:** `docs/DISCOVERY.md`, `docs/SOLUTION_DESIGN.md`, `docs/research/FREE_TIER_RESEARCH.md`.

## Next

- Milestone C — Database schema, multi-tenancy, RLS, seed data, pgvector KB
- Accounts still needed: Vercel, Google AI Studio (Gemini key), Groq, support Gmail

## Known issues

- gcloud is not on the default shell PATH (`/opt/homebrew/share/google-cloud-sdk/bin`); Claude uses the full path.

## Decisions

See `docs/DECISIONS.md`.
