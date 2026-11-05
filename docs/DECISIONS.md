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

## ADR-007: Gemini 3.8 Flash primary, Groq gpt-oss-120b fallback — superseded by ADR-022

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

## ADR-019: Data lifecycle runs in the database (pg_cron), not in the app

- **Context:** the spec asks for automatic deletion after a set period, and the shared public demo wears out (one visitor's refund or address change breaks the scenario for the next).
- **Decision:** `purge_expired_data()` deletes _finished_ tickets (resolved, closed or spam, with no pending escalation or refund) whose latest activity (ticket update or newest message) is past each tenant's `retention_days` (messages, runs, traces and escalations cascade; refunds keep their financial record with `ticket_id` nulled), chat sessions idle 7 days, processed-message ids 30 days past retention, and audit entries after 365 days. `reset_demo_data()` is generated into `seed.sql` from tenants marked `"demo": true` and restores their orders and payments and clears their refunds; each block also checks `tenants.is_demo` in SQL, and real tenants' orders are only inserted if missing, never overwritten or deleted (review finding: the first version would have reset a real client too). Only `postgres` (pg_cron) can run either function. pg_cron runs purge (03:17 UTC), demo reset (06:00) and rate-limit pruning (hourly).
- **Why in the database:** it runs even if the app is down or the Vercel cron is misconfigured, it is atomic, and Supabase's free tier includes pg_cron. Deletion counts are returned so `cron.job_run_details` shows what each run did.

## ADR-020: Email content goes only to providers that don't train on it

- **Context:** Gmail data falls under Google's API User Data Policy (Limited Use), and Gemini's free tier ("Unpaid Services") may use prompts to improve Google products. Groq's services agreement (§4.2) and Anthropic's commercial terms (§B) forbid training on customer inputs.
- **Decision:** each provider declares `trainsOnInputs`. Email tickets use a router built with `noTraining: true` (Groq today; Anthropic or a billing-enabled Gemini project when `GEMINI_PAID_TIER=true`) and keyword-only KB retrieval, because the free embedding API has the same terms. Chat keeps the full chain, and the privacy page says so.
- **Trade-off:** email loses Gemini as a fallback and loses vector search, so email retrieval recall and availability are measured separately in the evals (milestone I). If no no-training provider is available, the ticket goes to `needs_attention` (fail closed) rather than falling back to Gemini.

## ADR-021: CSP without nonces; Turnstile fails closed in production

- **Decision:** the CSP allows scripts and frames only from this origin and `challenges.cloudflare.com`, and `connect-src 'self'`. It keeps `'unsafe-inline'` for scripts, because a per-request nonce would make every page dynamic (no static landing page or partial prerendering). Turnstile guards the start of each chat session. Without a secret key it is skipped in development and refuses new sessions in production, and a Cloudflare outage also refuses them.
- **Why acceptable:** everything rendered is React-escaped text (no user HTML), and `connect-src 'self'` blocks exfiltration even if markup were injected. Revisit if the app ever renders HTML from emails.

## ADR-022: Production runs on the models the evals measured (Flash-Lite for chat, gpt-oss-20b for email)

- **Data (agent-v1.3.0, 47 cases, `evals/REPORT.md`):** Gemini 3.5 Flash-Lite passed 98% of cases (46/47) and gpt-oss-20b passed 96% (45/47), both with **zero safety (policy) failures**, 100% correct escalate/answer/close decisions for 20b, and 100% correct classification for both. LLM judge (n≈42): faithfulness 4.67 vs 4.50, tone 4.84 vs 4.90. Model time p50 4.0 s vs 2.2 s. Cost at paid list prices: $0.0026 vs $0.0005 per ticket ($2.60 vs $0.50 per 1,000 tickets).
- **Weak spots found:** 20b sometimes answers policy questions from memory instead of searching the help center (retrieval 80%; the French returns case invented a 30-day rule). Flash-Lite escalated one multi-question ticket it could have answered (safe direction).
- **Decision:** the chain starts with measured models: Flash-Lite → gpt-oss-20b → (unmeasured overflow) Gemini 3.8 / 3.6 Flash → gpt-oss-120b → 3.5 Flash. Email (no-training only, ADR-020) therefore runs gpt-oss-20b → 120b. The CI gate (`evals/thresholds.json`) holds both primaries to ≥ 80% pass and zero safety failures on every prompt change.
- **Why not the bigger Gemini Flash models:** they couldn't be measured on the free tier. They allow only a few requests per day (about one ticket per day once grading shared the quota), so they run a fixed 15-case sample that covers every category and are added to the report when complete. gpt-oss-120b (12/14 so far, no safety failures) is also still running. Choosing an unmeasured model as primary would be a guess. The evidence that a "smaller" model is good enough here is the useful result.
- **Trade-off:** email's agent and classifier now share gpt-oss-20b's daily token quota (~40 tickets/day before falling back to 120b). That's fine for the demo; a client would move to Groq's paid tier ($0.0005/ticket) or enable Anthropic (ADR-020).

## ADR-023: A reply may only claim actions that code performed

- **Context:** the grader (an LLM judge) caught gpt-oss-20b telling a customer "I’ve started that process for you now" (a carrier trace), and in a legal-threat draft "we're opening an internal investigation". No tool does either. The deterministic scorer missed the first one: it only knew refund/address claims and didn't match the typographic apostrophe. The threat model had listed this as an open item (OWASP LLM09).
- **Decision:** `src/lib/guardrails/claims.ts` detects claimed actions (refund, address change, trace/investigation/carrier contact), skipping promises and conditionals ("once it's processed…"). The outbound validator blocks a reply whose claim has no matching action in the states `executed`, `duplicate_ignored` (already done earlier) or `proposed` (draft-review mode: approving the draft executes it); the agent gets one rewrite, then the ticket escalates. Escalation drafts with a false claim are dropped. The eval scorer uses the same module, so CI and production share one definition.
- **One rule everywhere:** `claimableTypes()` (in `claims.ts`) decides which actions a reply may describe as done, and both the guardrail and the scorer call it. A proposed action counts only when it is the ticket's single pending action, since approval executes exactly one. Invisible format characters are stripped, and a "when/once/after/if" only makes a claim a promise inside its own clause ("Once again, your refund has been processed" is still a claim). Both were review findings.
- **Known limits:** the check is pattern-based, so unusual phrasing or other languages can slip past (refund claims in German and Spanish are covered). It checks the action type, not the amount: "I've refunded $500" after a $49 refund passes. Human review of escalations and the LLM judge are the backstops. A later step could compare amounts in the reply with the recorded action.
- **Validation:** over all 209 stored replies from every model and run, it flags exactly the false claims above and none of the honest ones (6 true "I've processed a refund / updated your address" claims pass). Tests cover each pattern, the curly apostrophe, promises, draft mode, and the agent's rewrite path.
- **Grading:** the judge moved from Gemini to Groq `qwen/qwen3.8-27b`, which isn't one of the compared models and has its own free quota (Gemini grading had been using up the candidates' daily requests). It writes its reasoning before its scores, and the rubric spells out what each score means. The first version scored a correct escalation 1/5 while praising it in the rationale. The judge still over-flags honest escalations ("I'll forward your request"), so its "invented actions" count is a pointer for human review, not a gate.

## ADR-024: Production on Vercel Hobby, with Gmail polling scheduled in the database

- **Decision:** the app runs on Vercel Hobby (free, no card), deployed from GitHub (main → production). Gmail is polled every 2 minutes by Supabase pg_cron through pg_net, calling the app's poll endpoint with `CRON_SECRET` read from Supabase Vault. Address: `ai-support-ops-agent.vercel.app`.
- **Why the database schedules it:** Vercel Hobby crons run at most once a day. pg_cron is free, already runs the lifecycle jobs (ADR-019), keeps working when no one visits the site, and its calls keep the free Supabase project from pausing. Gmail push (Pub/Sub) would need a Google Cloud billing account.
- **Secrets:** the Keychain stays the source of truth. `push-vercel` refuses development-only values (Turnstile test keys, localhost URLs) for production; this guard was added after a manual push briefly sent the test keys. Vault secrets go through stdin, never a command line or file. The poll function is executable only by pg_cron.
- **Gmail:** the OAuth app is published (unverified, fine for a single inbox, under 100 users), so the refresh token no longer expires after 7 days. The branding links point to the live `/privacy` and `/terms`.
- **Verified live (2026-11-05):** a real email was answered 6.7 s after it was fetched. The chat answered a visitor after the Turnstile check, and the read-only demo dashboard works. 8 HTTP smoke tests run after each production deploy.
- **Found by the live test:** a visitor took more than 30 s to tick "Verify you are human", so the chat now waits up to 2 minutes once Cloudflare asks and shows a hint. Model Markdown showed as raw `**` in plain-text email, so the email composer now strips it in code rather than in the prompt, which keeps the eval results valid.

## ADR-025: Dashboard access is scoped per client; the public demo sees demo tenants only

- **Context (found while writing the onboarding runbook):** `npm run dashboard:users` gave the public demo viewer the viewer role on **every** tenant, and gave any invited person owner on every tenant. With only fictional demo tenants nothing was exposed. But onboarding a real client this way would have shown that client's tickets to anyone clicking "View demo dashboard", and given the client's team access to other clients.
- **Decision:** the demo viewer is granted only on tenants with `is_demo = true`, and is removed from any tenant that isn't a demo. Inviting without `--tenant` makes the operator an owner everywhere; `--tenant <slug> --role owner|agent|viewer` invites a client's team to that client only. RLS (ADR-009, ADR-018) still enforces visibility row by row; this keeps memberships correct in the first place.
- **Hardened after the security review:**
  - The database now enforces it too (migration 13): the viewer role only sees tickets on demo tenants, so a stray membership on a real tenant shows nothing.
  - Invites fail closed: unknown or malformed arguments are rejected, and access to every tenant needs an explicit `--all-tenants`.
  - Client teams get `owner` or `agent`; `viewer` is reserved for the public demo.
- **Lesson:** writing the runbook step "invite the client's team" was what surfaced it. Documentation is a review.
