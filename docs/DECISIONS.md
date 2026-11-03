# Decision Log

Architecture decision records (ADRs) — short, with context and trade-offs. Newest last.

## ADR-001: Next.js on Vercel as a single full-stack app

- **Context:** Need a landing page, dashboard, chat widget, webhooks and API routes, hosted for $0.
- **Decision:** One Next.js (App Router, TypeScript) app deployed to Vercel Hobby.
- **Why:** One codebase and one deploy for UI + API; first-class Vercel support; serverless functions handle webhooks; preview deploys per PR come free.
- **Trade-offs:** Serverless time limits on Hobby constrain long agent runs → agent loop needs strict step/time budgets. Long-running background workers are not available, so email polling uses scheduled triggers instead.

## ADR-002: Zod at every boundary

- **Decision:** Validate env vars, API input, tool arguments and model structured output with Zod schemas.
- **Why:** LLM output and inbound messages are untrusted; schema validation turns "probably right" into "provably shaped right" and gives a single place to reject or retry.

## ADR-003: Guardrails as code, not prompt

- **Decision:** Hooks block Claude from editing secret files; CI runs lint, type-check, tests, build, secret scan (gitleaks) and dependency audit on every push/PR.
- **Why:** Rules that matter are enforced by machines, not memory — the same principle the product applies to the agent's business rules.

## ADR-004: Claude Code permissions — broad allow, irreversible actions ask, secrets denied

- **Context:** The user wants minimal permission prompts. Independent security review flagged that file-tool deny rules alone don't stop shell access to secrets.
- **Decision:** Allow routine tools broadly; keep an "ask" list only for irreversible actions (force-push, hard reset, recursive delete, deleting repos/projects/DB resets); deny reading secret files; a PreToolUse hook blocks any Read/Edit/Write/Grep/Bash call that references a secret file, failing closed on bad input. The hook has its own tests.
- **Trade-off:** Fewer prompts means less human review of each command; mitigated by the hook, CI, git history, and review subagents before each merge.

## ADR-005: Commit identity

- **Decision:** Commits use the GitHub no-reply address for `klinsmanne`.
- **Why:** Credits work to the right profile while keeping personal email out of public history.

## ADR-006: Poll Gmail from Supabase pg_cron (not Gmail push, not Vercel cron)

- **Context:** $0, no credit card. Gmail push needs Cloud Pub/Sub, which needs a GCP billing account. Vercel Hobby cron runs at most once a day.
- **Decision:** Supabase `pg_cron` + `pg_net` calls a signed poll endpoint every 2 minutes; the endpoint uses `history.list` (2 quota units/call).
- **Trade-off:** up to ~2 min latency vs instant push — negligible against a 9.5 h baseline. Bonus: constant DB activity prevents the free project from pausing.

## ADR-007: Gemini 3.8 Flash primary, Groq gpt-oss-120b fallback — provisional

- **Decision:** Start with the most capable free Gemini model; fall back to Groq on rate limits/outages; keep a Claude adapter inactive.
- **Why provisional:** final choice is made from eval-suite data (quality, policy compliance, latency, cost/ticket) in milestone I.

## ADR-008: Secrets live in the macOS Keychain locally, Vercel env in the cloud

- **Context:** The user is a beginner; secrets must never be pasted around, printed, or committed — including into the AI assistant's context.
- **Decision:** `scripts/secrets.mjs` stores values in the Keychain (`ai-support-agent/<NAME>`), generates the git-ignored local env file (mode 600) and pushes values to Vercel via stdin. Values are never printed. Keys are piped directly from provider CLIs where possible.
- **Trade-off:** macOS-only for local dev; a teammate on Linux/Windows would use `vercel env pull` instead.

## ADR-009: Multi-tenant isolation in three layers

1. **Database:** RLS on every table; composite `(tenant_id, id)` foreign keys make cross-tenant references impossible even for the service role.
2. **Application:** every repository function takes `tenantId` explicitly; retrieval (`match_kb_chunks`) requires a tenant id and is callable only by the backend.
3. **Tests:** PGlite runs the real migrations in CI and proves members of one tenant cannot read or modify another's data.
