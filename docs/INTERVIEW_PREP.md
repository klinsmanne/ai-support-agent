# Interview prep

Questions a Forward Deployed Engineer or AI Engineer interviewer is likely to ask about this project, with answers grounded in what was actually built. Each points to the evidence. Answer in your own words; these are notes, not a script.

## The 30-second pitch

"I built a multi-tenant AI support agent for a fictional retailer as if it were a client engagement, from discovery to handoff. It answers email and chat, looks up orders, issues refunds within policy, and hands anything risky to a human with a draft. The model only proposes; code enforces refund limits, tenant isolation and reply safety. I picked the production models with a 47-case eval suite. The two I chose pass 96–98% with zero safety failures, and the evals caught a safety bug I then fixed in production. It's live, it costs $0, and a second client is just a config folder."

## Customer engagement (FDE)

**How did you figure out what to build?**
I ran a simulated discovery with five stakeholders: the VP of CX, the support lead, finance, engineering and legal. It gave me the ticket mix (75% routine), the baseline ($7.80 and 9.5 h per ticket), and the fears, especially the support lead's fear of wrong refunds. That fear shaped the design: code-enforced limits, escalation with drafts, and a staged rollout. → `docs/DISCOVERY.md`

**How would you roll this out at a real client?**
In shadow mode for a week (the agent drafts and nothing is sent), then draft-only with one-click approval, then auto-send. Each stage has gates agreed with the client in advance, such as approval-without-edit rate and escalation precision. The kill switch is always one click away. → `docs/ONBOARDING_RUNBOOK.md` §6

**A client says "the AI gave a customer a wrong answer." What do you do?**

1. Kill switch if it's systemic.
2. Open the trace and see what it looked up and which policy it used.
3. Turn it into an eval case.
4. Fix the cause (prompt, policy, help-center article or guardrail), run the evals, and ship it through the gate.

The "claimed a carrier trace" bug followed exactly that path. → ADR-023

**How do you show business value?**
The dashboard shows auto-resolution, first response, cost per ticket and agent hours saved against the discovery targets. In the case study I separate measured numbers from projections, and I show the blended-cost math: it hits the $3.50 target because approved drafts halve agent time. → `docs/CASE_STUDY.md`

## AI engineering

**Why these models?**
Data. The plan was the biggest free Gemini model. The eval suite measured Gemini 3.5 Flash-Lite at 98% and Groq gpt-oss-20b at 96%, both with zero safety failures. The bigger models couldn't even be measured on the free tier's daily quota. Email uses gpt-oss-20b because Groq's terms forbid training on inputs and Gemini's free tier doesn't. → ADR-020, ADR-022, `evals/REPORT.md`

**How do your evals work?**

- **47 cases** across 9 categories.
- **Deterministic checks:** classification, the escalate/answer/close decision, required tools, expected actions, safety (no unexpected actions, no other customers' data, no claimed-but-not-performed actions) and retrieval.
- **LLM judge** for faithfulness, helpfulness and tone. It's graded against the exact evidence the agent saw, and runs on a model that isn't one of the candidates.
- **Resumable on free tiers:** results are re-scored with the current scorer.
- **CI gate:** fails on a prompt change without new results, any safety failure, or a regression. → `evals/README.md`

**What did the LLM judge get wrong, and how did you handle it?**
The first judge gave a correct escalation 1/5 while praising it in its rationale. Making it write the reasoning before the scores, with anchored rubric descriptions, fixed that. It still over-flags honest escalations as "invented actions", so the judge points humans at replies to read and never gates. The deterministic checks gate. → ADR-023

**How do you handle prompt injection?**

- **In:** all inbound text is wrapped as untrusted data, and suspected injection removes the write tools and routes to a human.
- **Out:** replies are validated (no secrets, no system prompt, no other customers' data, allowed links only, no false claims).
- **Throughout:** the model never has authority. Even a fully hijacked model can only _request_ a refund that code then checks. There are 6 injection cases in the evals, including Unicode-obfuscated and Spanish ones. → `docs/THREAT_MODEL.md`

**How does retrieval work?**
Per-tenant help-center articles are chunked into Markdown chunks. Chat uses hybrid retrieval (pgvector embeddings plus Postgres full-text search). Email uses keyword-only search, because the free embedding API has the same training terms as Gemini. Replies cite the articles used, and policy questions without a source escalate when confidence is low.

## Production engineering

**How is tenant isolation enforced?**
In three layers:

- **App:** every query is scoped by `tenant_id`.
- **Database:** composite foreign keys, so a row can't point at another tenant's data.
- **RLS on every table.**

Database tests run against PGlite and try cross-tenant reads and writes. → ADR-009, `tests/db/tenant-isolation.test.ts`

**What happens when a model provider is down or out of quota?**
A fallback chain across providers. A daily-quota error is classified differently from a per-minute rate limit: it's skipped for an hour with no waiting. If every model fails, the ticket goes to a human instead of being dropped. → ADR-010, ADR-015

**How do you prevent double processing or double refunds?**

- **At-most-once message processing,** with a ledger keyed by provider message ID.
- **Idempotent refunds** inside one atomic database function.
- **A poll lease,** so two Gmail polls can't overlap.
- **Approval order:** approving a draft claims the escalation first, runs the action, then sends the reply. → ADR-012, ADR-017, ADR-018

**How do you deploy safely?**

- One PR per milestone, each with a security review and a code-quality review before merge.
- CI runs lint, types, format, tests, the eval gate, a secret scan and a dependency audit.
- Vercel deploys main. A workflow waits until `/api/health` reports the new commit, then runs live smoke tests.
- Rollback is one click in Vercel. → `docs/DEPLOYMENT.md`

## Scaling and enterprise deployment

**How would it handle 10× or 100× the volume?**
The bottleneck today is free-tier model quotas, not the architecture.

1. **Paid model tiers.** gpt-oss-20b costs $0.0005 per ticket at list price, so 65,000 tickets a month is about $33 of model cost.
2. **A queue instead of request-driven polling.** Gmail push via Pub/Sub, or a helpdesk webhook, feeds a durable queue with worker concurrency. The ingest step is already idempotent, so workers can retry safely.
3. **Postgres scales further than this needs:** per-tenant indexes are in place, the vector index needs tuning at millions of chunks, and old traces get archived.
4. **Prompt caching and a smaller classifier** for the cheap first step.

The fallback chain and per-tenant daily caps already protect the downstream services.

**How would you deploy it for a real enterprise customer?**

- **Their cloud and their keys:** the same code in their Vercel or AWS account, their Supabase or managed Postgres, and their model contracts with zero data retention.
- **Their identity:** SSO (SAML or OIDC) for the dashboard, mapped to the existing owner/agent/viewer roles.
- **Their systems:** replace the simulated tools with their order, payment and carrier APIs behind the same policy engine, plus a helpdesk adapter (Zendesk or Intercom) through the channel interface.
- **Their governance:**
  - a security review of the threat model;
  - DPA, data residency and retention settings;
  - audit-log export to their SIEM;
  - an on-call runbook (HANDOFF.md).
- **Their data in evals:** anonymized historical tickets as eval cases, a week in shadow mode, then draft-only with agreed gates.

**What breaks first in production?**

1. **Integration edge cases:** partial refunds, split shipments, orders edited by staff mid-conversation.
2. **Retrieval drift** when the help center changes.
3. **Model behavior** after a provider update.

Defenses: the trace view for diagnosis, the eval gate on every prompt change, re-running evals when a provider changes a model, and the kill switch.

**Multi-region or data residency?**
Supabase projects are regional, so a residency-bound client gets its own project (same migrations, seed generator and code), deployed next to a model endpoint in the required region. Pinning a provider region per tenant isn't built yet; it would be a tenant setting read by the provider layer.

## STAR stories (have two ready)

**1. The evals found a safety bug.**

- **S:** Comparing models on 47 cases.
- **T:** Pick a production model, and make sure replies never lie about actions.
- **A:** The LLM judge flagged gpt-oss-20b saying "I've started that process", meaning a carrier trace no tool can open. My regex scorer missed it because of a curly apostrophe. I wrote one claim detector shared by the scorer and a new production guardrail, and validated it on 209 stored replies with zero false alarms.
- **R:** A failure class the threat model had predicted is now blocked in production and measured in CI. → ADR-023

**2. A review caught what I'd just shipped.**

- **S:** Live testing showed model Markdown in plain-text email.
- **T:** Fix the formatting without breaking the eval results.
- **A:** I stripped Markdown in code. The security review then showed that the stripping ran _after_ the guardrail, so `**https**://evil.com` passed the check and became a real link. I changed the guardrail to check the reply as written, as sent, and with marks around dots removed, and added regression tests.
- **R:** Fixed before merge. Lesson: validate exactly what leaves the system.

## Questions to ask them

- "How do your forward deployed engineers decide when an AI should hand off to a human at a client?"
- "How do you measure quality on a client's data before go-live?"
- "What does the path from a pilot to production usually block on: security review, integrations or trust?"
