# PRD: AI Customer Support Operations Agent (pilot)

_Owner: engagement lead · Client: Harbor & Pine (fictional) · Status: pilot shipped · Inputs: [DISCOVERY.md](DISCOVERY.md) · Value case: [BUSINESS_CASE.md](BUSINESS_CASE.md)_

## 1. Problem

Harbor & Pine's 9 agents handle about **6,500 tickets a month**. The median first response is **9.5 h** (30 h+ at weekends), and each ticket costs **$7.80** (about 8 agent-minutes). **75%** of tickets are order status, returns, refunds or address changes, answerable by a lookup and a policy. Refunds are inconsistent and unaudited. The support lead's main fear is an AI issuing wrong refunds.

## 2. Users and jobs

| User                             | Job to be done                                                  | What success looks like to them                                                 |
| -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Customer                         | "Tell me where my order is / fix my charge, now"                | A correct answer in minutes, in their language, and a person when they need one |
| Support agent                    | "Stop copying order data into emails; spend time on hard cases" | Routine tickets gone; escalations arrive with context and a draft               |
| Support lead                     | "Keep quality and trust while going faster"                     | Control over what the AI may do; one-click approvals; a kill switch             |
| Finance controller               | "No refund outside policy, and an audit trail"                  | Limits enforced, every action logged with who, what and why                     |
| VP Customer Experience (sponsor) | "Lower cost per ticket without hurting CSAT"                    | KPI dashboard against targets                                                   |
| Legal / privacy                  | "Customers know it's AI; data isn't kept forever"               | AI disclosure in every reply; automatic retention                               |

## 3. Goals and non-goals

**Goals (90-day targets from discovery):**

- ≥ 50% of non-spam tickets auto-resolved;
- first response < 2 minutes;
- cost < $3.50 per ticket;
- CSAT ≥ 80%;
- **0 unauthorized refunds**;
- ≥ 90% escalation precision.

**Non-goals for the pilot:**

- voice and social channels;
- real payment-processor and carrier integrations (simulated, behind the same tools);
- migrating off the current helpdesk;
- SSO for the dashboard.

## 4. Requirements

**Must have (MVP: shipped)**

| #   | Requirement                                                                                                                     | Acceptance criteria                                                           | Status                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| M1  | Email + website chat intake, threaded into tickets                                                                              | Follow-ups join the same ticket; duplicates and loops are never answered      | ✅                               |
| M2  | Understand each message: intent, urgency, sentiment, language, customer                                                         | Classification accuracy ≥ 90% on the eval set                                 | ✅ 100% on the production models |
| M3  | Investigate with tools (orders, history, help center with citations)                                                            | Required tools used in ≥ 95% of eval cases                                    | ✅ 100%                          |
| M4  | Act within policy: refunds up to the limit, address change before shipping                                                      | **0** policy violations in evals; limits enforced in code and in the database | ✅ 0 safety failures             |
| M5  | Escalate with a summary, evidence and a draft when over a limit, upset, unsure, injection is suspected, or a human is requested | Correct resolve/escalate decision ≥ 90%                                       | ✅ 98–100%                       |
| M6  | Every reply validated, disclosed as AI, with a human option                                                                     | No leaks, unapproved links or false action claims                             | ✅                               |
| M7  | Rollout modes (shadow, draft-only, auto-send) and a kill switch, per client                                                     | One setting; takes effect on the next ticket                                  | ✅                               |
| M8  | Dashboard: queue, traces, approvals, settings, KPIs                                                                             | Sponsor can read the KPIs against targets without help                        | ✅                               |
| M9  | Multi-client: a new client is configuration only                                                                                | Second client (Cadence) onboarded with no code change                         | ✅                               |

**Should have (next):**

- real refund and carrier APIs behind the same tools;
- per-client inboxes;
- amount checking in replies;
- SSO;
- an external uptime monitor.

**Could have:**

- a helpdesk adapter (Zendesk or Intercom);
- proactive outreach for delayed orders.

## 5. Success metrics and how they're measured

| Metric                                                                               | Source                                                     | Gate                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Auto-resolution, escalation rate, first response, hours saved, cost per ticket, CSAT | Dashboard Overview (live)                                  | Reviewed weekly with the support lead                              |
| Correctness and safety                                                               | 47-case eval suite ([evals/REPORT.md](../evals/REPORT.md)) | CI blocks a release with a safety failure or a pass rate under 80% |
| Escalation precision                                                                 | Weekly sample of 20 escalations                            | ≥ 90% judged necessary                                             |
| Adoption (internal)                                                                  | Approvals per day; edits per draft                         | Drafts approved without edits ≥ 80% before auto-send               |

## 6. Rollout

Shadow (1 week) → draft-only (1–2 weeks) → auto-send. Each gate is agreed with the sponsor in advance ([ONBOARDING_RUNBOOK.md](ONBOARDING_RUNBOOK.md) §6).

## 7. Risks

| Risk                           | Mitigation                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong or unauthorized refund   | The model only requests; code and the database enforce limits; human approval above $75                                                              |
| Prompt injection               | Inputs treated as data; write tools removed when suspected; human review ([THREAT_MODEL.md](THREAT_MODEL.md))                                        |
| Hallucinated policy or actions | Retrieval with citations; low confidence escalates; claimed actions checked against what code did (ADR-023)                                          |
| Free-tier limits at peak       | Model fallback chain; tickets go to humans, never dropped; a paid tier costs about $3–17/month at this volume ($3 on gpt-oss-20b, $17 on Flash-Lite) |
| Low trust or adoption          | Staged rollout, visible traces, one-click approvals                                                                                                  |

## 8. Open questions for the client

1. The refund auto-approve limit: keep $75, or start lower in month 1?
2. Which languages and markets go to auto-send first?
3. Who owns help-center updates, since the agent quotes them?
4. The SLA for escalated tickets during weekends?
