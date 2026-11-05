---
description: Onboard a new client (tenant) through configuration only, following docs/ONBOARDING_RUNBOOK.md
argument-hint: "<client-slug>"
---

Onboard a new client named `$ARGUMENTS` by following `docs/ONBOARDING_RUNBOOK.md` step by step.

1. Ask the user (one question at a time, with sensible defaults offered) for anything discovery should have answered: company name and industry, policies (refund auto-approve limit, refunds per 30 days, whether address changes are allowed), languages, brand voice, link domains, retention days, the support email address, and the dashboard owner's email.
2. Create `tenants/<slug>/tenant.json` (copy `tenants/cadence-analytics/` as the template) with `"rollout_mode": "shadow"` and `"demo": false`, and `tenants/<slug>/kb/*.md` help-center articles (one topic per file; use what the user provides, never invent policy).
3. `npm run seed:build` and `npm run check`. Fix schema errors.
4. Ask before touching production, then: `supabase db push --remote --include-seed --yes`, `npm run kb:embed`, and `npm run kb:search -- "<a typical question>" <slug>` to confirm retrieval.
5. Invite the client's owner to **their tenant only**: `npm run dashboard:users -- <owner-email> --tenant <slug> --role owner` (add the client's agents with `--role agent`). Never use `--all-tenants` for a client.
6. Commit on a branch, open a PR, and give the user the rollout plan from runbook step 6 (shadow → draft-only → auto-send) with the gates to agree with the client.
