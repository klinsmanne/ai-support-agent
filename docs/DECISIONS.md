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

## ADR-010: Model fallback chain with short timeouts (observed, not assumed)

- **Observation (2026-11-03, live probe):** `gemini-3.8-flash` and `gemini-3.7-flash` returned 503 "high demand"; one request to 3.8 hung > 2 minutes without a timeout. `gemini-3.6-flash` (1.4 s), `gemini-3.5-flash` (2.5 s) and `gemini-3.5-flash-lite` (0.6 s) answered.
- **Decision:** the provider layer tries an ordered chain — Gemini 3.8 Flash → 3.6 Flash → 3.5 Flash-Lite → Groq — with a per-call timeout and a circuit breaker that skips a model for a cool-down after repeated 503/429s. The final order is chosen from eval results (milestone I).
- **Why:** free tiers have no SLA; resilience has to come from the architecture.

## ADR-011: Calibrated sentiment anchors (first eval-driven prompt change)

- **Observation (live run, prompt agent-v1.1.0):** "I was charged twice, this is ridiculous" was scored −0.8 and escalated on sentiment (threshold −0.7), although the spec says frustration alone should not block a within-policy refund.
- **Change (agent-v1.2.0):** explicit sentiment anchors in the classifier prompt (−0.5 frustrated, −0.8 very angry, −1.0 abusive/distress) and Harbor & Pine's threshold moved to −0.85.
- **Why it matters:** escalation precision is a client KPI (≥ 90% of escalations necessary). Thresholds are tenant config, so this was a config + prompt change with no code change, and it is now covered by an eval case.

## ADR-012: Money moves atomically in the database, not just in application code

- **Context (security review, milestone D):** policy checks ran in TypeScript, then the refund was inserted later — two tickets from one customer (email + chat at once) could both pass. The idempotency key included the ticket and amount, so it didn't dedupe across tickets.
- **Decision:** `create_refund_checked` (SQL, `SECURITY INVOKER`, service role only) locks the order row (`FOR UPDATE`), re-checks the refundable balance and the 30-day limit, and inserts in one transaction. Idempotency is one refund per _(order, reason)_. The agent may execute at most one account action per ticket.
- **Why:** "business rules in code" must hold under concurrency, not just in the happy path. The TypeScript policy engine stays as the explainable first gate; the database is the final one.

## ADR-013: Parse links, don't pattern-match them

- **Context:** the first reply validator matched `https?://host` with a regex; the review showed `https://evil.com?.allowed.com`, `www.evil.com`, markdown links without a scheme, `//evil.com` and `javascript:` all slipped through.
- **Decision:** extract every link-like token (https URLs, markdown targets, protocol-relative, bare domains, any scheme), resolve hosts with `new URL()`, allow only `https` to allowlisted domains. Each bypass is a regression test.

## ADR-014: Operational lesson — verify the live state, never trust filtered output

- A migration silently failed (Supabase forbids `set hnsw.iterative_scan` on functions) and the whole transaction rolled back; an output filter hid the error and a weaker check looked green. Now every `db push` is followed by a read-only query asserting the expected objects exist (grants, functions, constraints, RLS).

## ADR-015: Daily free-tier quotas are a different failure from rate limits

- **Observation (live chat test, 2026-11-03):** after a day of testing, Gemini returned 429 "exceeded your current quota" (daily). The router treated it like a per-minute limit — waited 8 s, retried — and the 45 s budget ran out before Groq (with spare capacity) was tried. The ticket escalated with a holding reply. The trace in `trace_events` showed exactly why.
- **Decision:** classify 429s from provider details (Gemini `QuotaFailure.quotaId` …`PerDay`…, Groq "requests per day (RPD)") as `quota_exhausted` → skip that model for 1 hour, never wait. Wait only when every provider gave an explicit retry hint. Interleave providers in the chain (Gemini 3.8 → 3.6 → Groq 120b → Gemini 3.5 → 3.5-lite → Groq 20b); classification starts on Groq 20b (0.7 s vs up to 50 s for Flash-Lite).
- **Why it matters:** on free tiers, capacity is a portfolio of small per-model quotas; resilience = spending them in the right order, and observability is what made the diagnosis a 2-minute query.

## ADR-016: Email trust = DMARC-aligned authentication, read only from our own receiving server

- **Context (security review, milestone E):** `spf=pass && dkim=pass` only proves the _sending_ domain — an attacker's own domain passes both while forging `From: customer@…`. Also, every `Authentication-Results` header was parsed, so an attacker could add their own "dmarc=pass".
- **Decision:** trust only the topmost header stamped by `mx.google.com`; a sender is authenticated if DMARC passes or SPF/DKIM pass for a domain aligned with From (RFC 7489 relaxed). Unauthenticated senders never receive mail from us (no backscatter); their drafts wait for a human (`unauthenticated_sender`).

## ADR-017: At-most-once processing; humans keep the tickets they own

- **Decision:** a provider message is processed at most once — failures (or runs stuck in `processing` > 10 min, swept each poll) become `needs_attention` instead of being re-run, because a re-run could email the customer twice. Follow-ups on `escalated`/`needs_attention` tickets are attached without running the AI. Email tickets are keyed by Gmail thread **and sender**, so a stranger replying into a thread never sees another customer's history.
- **Poller:** fetched ids go into a persisted queue and the history cursor advances immediately, so a backlog larger than one cycle drains instead of stalling.

## ADR-018: The public demo sees only fictional data; approval executes the action before the reply

- **Context (security review, milestone F):** the demo viewer role could read every ticket, including email tickets from real people who wrote to the support inbox. Approving a draft that promised a refund sent the promise without issuing the refund.
- **Decision — viewer privacy in the database:** `can_read_ticket()` lets owners/agents see everything; viewers see only tickets tied to a seeded (fictional) customer or from the chat widget. Messages, escalations, runs and traces follow their ticket; the audit log is staff-only. RLS enforces it, so no dashboard bug can leak it.
- **Decision — approval order:** claim the escalation (conditional on `pending`, so a double click can't act twice), execute the proposed action (refunds through the atomic `create_refund_checked` with idempotency key `escalation:<id>`), and only then send the reply. If sending fails after the action ran, the ticket goes to `needs_attention` instead of rolling back silently.
- **Decision — sign-in:** links are built from `APP_URL` only (required in production; a forged Host header can't redirect a token), membership lookup and sending run in `after()` so neither the response text nor its timing reveals who is invited, and the demo signs in through a server-minted one-time token (no shared password to change or leak).
