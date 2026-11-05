---
description: Ship the current branch to production safely (checks, PR, CI, merge, live smoke tests)
---

Deploy through GitHub, never straight from a laptop, unless the user explicitly asks.

1. Run `/verify` (lint, types, format, tests, build) and `npm run eval:gate`. Stop and fix on failure.
2. If there are new files under `supabase/migrations/`, list them, explain in one sentence each what they change in the live database, and ask the user before `supabase db push --remote --yes`. Apply them **before** merging when the new code depends on them.
3. If Vercel env vars changed, ask, then `npm run secrets push-vercel production` (it skips development-only values).
4. Commit, push the branch, open a PR (`gh pr create`), wait for CI to pass. Run the security and code-quality review subagents for milestone-sized changes and fix their findings.
5. Merge (`gh pr merge --merge`). Vercel deploys `main` automatically; the `E2E (live site)` workflow waits for `/api/health` to report the new commit and runs the smoke tests. Report its result.
6. Rollback if needed: Vercel → Deployments → previous → Promote to Production (docs/DEPLOYMENT.md).
