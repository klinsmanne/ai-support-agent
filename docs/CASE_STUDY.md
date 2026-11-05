# Case study: an AI support agent that knows when to hand off

_Fictional client (Harbor & Pine Home Goods), real build. Measured results are marked **measured**; business projections are marked **projected** and show their math._

## The problem

Harbor & Pine is an online home-goods retailer with 9 support agents and about **6,500 tickets a month**.

- **Slow:** the median first response was **9.5 hours**, and over 30 hours at weekends.
- **Expensive:** each ticket cost about **$7.80**, roughly 8 minutes of an agent's time.
- **Repetitive:** 75% of tickets were order status, returns, refunds or address changes, and about 60% of agent time went to copying data from the order system into emails.
- **Unaccountable refunds:** finance had no audit trail for who approved a refund, or why.

The sponsor wanted faster, cheaper support. The support lead's fear was an AI handing out wrong refunds, and finance and legal had their own concerns. ([Discovery](DISCOVERY.md))

**Targets agreed in discovery:**

- ≥ 50% of tickets auto-resolved;
- first response under 2 minutes;
- under $3.50 per ticket;
- zero unauthorized refunds;
- customers always told they're talking to an AI.

The budget was **$0** for the pilot.

## The approach

**1. Treat the model as untrusted.** It proposes and code decides.

- Refund limits, refund frequency, order ownership, tenant isolation and "one account action per ticket" live in a policy engine and in an atomic database function.
- Every inbound email and chat message is data, never instructions.
- Every outbound reply is checked before it's sent.

**2. Design for the handoff, not just the answer.** Escalation is a first-class outcome. A human gets a summary, the evidence and a draft to approve with one click. Rollout goes shadow → draft-only → auto-send, with agreed gates between stages, and a kill switch stops the AI instantly.

**3. Let measurements pick the model.** A 47-case eval suite covers easy, hard, angry, ambiguous, multilingual, spam, prompt-injection, cross-tenant and policy-edge tickets.

- Deterministic checks score classification, escalation decisions, tool use, safety and retrieval.
- An LLM judge grades faithfulness, helpfulness and tone.
- CI blocks a prompt change that has no new results, and any safety failure.

**4. Make a second client a config file.** Cadence Analytics is a SaaS company with different policies, voice, languages and rollout mode. It runs on the same deployment from one folder of configuration, and row-level security keeps the two apart.

## What happened

**The evals changed the plan twice.**

- **Model choice.**
  - The plan was to run the biggest free Gemini model.
  - The measured winners were **Gemini 3.5 Flash-Lite (98%)** and **Groq gpt-oss-20b (96%)**, both with **zero safety failures** (**measured**).
  - The larger models couldn't even be measured on the free tier.
  - Production now runs the measured models first. Email uses gpt-oss-20b because, unlike Gemini's free tier, Groq doesn't train on customer data.
- **A safety gap.**
  - The LLM judge caught gpt-oss-20b telling a customer "I've started that process for you now", meaning a carrier trace no tool can open. It also caught "we're opening an internal investigation".
  - My regex checks had missed the first one because of a curly apostrophe.
  - The threat model had predicted exactly this failure. Now an outbound guardrail blocks any reply claiming an action code didn't perform. On all 209 stored replies it flags only the real false claims, none of the honest ones (**measured**).

**Live testing found what tests didn't.**

- A visitor took longer than 30 seconds to tick "I'm human", so the chat now waits up to 2 minutes and shows a hint.
- Model formatting showed up as raw `**` in Gmail, so the email composer strips it.
- A security review then found that the stripping could reassemble a disguised phishing link _after_ the guardrail had checked the reply. The guardrail now checks the exact text that gets sent.

**Reviews before every merge.** Each milestone had a security review and a code-quality review. They found, among other things:

- a demo-data reset that could have wiped a real client;
- a retention purge that could delete open tickets;
- overlapping inbox polls that could lose retries.

All were fixed before merge.

## Results

| Metric                             | Target        | Result                                                                                                                                                                                        |
| ---------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthorized refunds               | 0             | **0 by construction** (code limits + atomic DB function; tested) and **0 safety failures** in 47 eval cases on both production models (**measured**)                                          |
| AI disclosure + human option       | Every reply   | Added in code to every reply (**measured**, tested)                                                                                                                                           |
| First response                     | < 2 min       | **6.7 s** after fetch on a live email; worst case ≈ 2 min poll interval + processing (**measured**)                                                                                           |
| Cost per AI-handled ticket         | —             | **$0.0005** (gpt-oss-20b) / **$0.0026** (Flash-Lite) at paid list prices; $0 on free tiers (**measured** tokens × list price)                                                                 |
| Correct handling on the eval suite | —             | **96–98%** of cases fully correct (**measured**)                                                                                                                                              |
| Auto-resolution rate               | ≥ 50%         | **Projected**: discovery says ~75% of tickets are resolvable categories; with escalations for limits, anger and low confidence, 50–60% is realistic. Measured in shadow mode before auto-send |
| Cost per ticket (blended)          | < $3.50       | **Projected $2.73**: 50% auto (≈ $0) + 30% approved drafts (4 min ≈ $3.90) + 20% fully human ($7.80)                                                                                          |
| Agent hours saved                  | ≥ 400 h/month | **Projected ~430 h/month**: 50% × 6,500 tickets × 8 min                                                                                                                                       |

Blended cost formula: 0.5 × $0.003 + 0.3 × $3.90 + 0.2 × $7.80 ≈ $2.73. At exactly 50% auto-resolution with no drafts, it's $3.90. The draft queue is what makes the target reachable, because an approved draft takes about half an agent's time.

## What I'd do next

1. Run the client's own anonymized tickets as eval cases, in shadow mode, for a week.
2. Replace the simulated refund and tracking tools with real APIs, behind the same policy checks.
3. Move email to a paid no-training tier (about $3/month at this volume) for headroom.
4. Add a second alert channel, and measure escalation precision weekly.

## Built with

Next.js 16, TypeScript, Supabase (Postgres + RLS + pgvector + pg_cron + Vault), Gemini and Groq free tiers (Claude-ready), Zod, Vitest, GitHub Actions, Vercel and Cloudflare Turnstile. Total cost: $0. ([README](../README.md))
