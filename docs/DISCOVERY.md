# Customer Discovery — Harbor & Pine Home Goods

_Fictional client. All names, numbers and data are illustrative._
_Engagement: AI Customer Support Operations Agent · Discovery completed 2026-11-03_

## 1. Client snapshot

| Item           | Detail                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Company        | Harbor & Pine — online retailer of home goods (bedding, kitchen, decor)                         |
| Size           | ~120 employees, ~$38M annual online revenue, ~42,000 orders/month                               |
| Markets        | US, Canada, Mexico, Spain (English + Spanish customers, some French-Canadian)                   |
| Support team   | 9 agents + 1 lead, two shifts, Mon–Sat; no Sunday coverage                                      |
| Channels today | Shared Gmail inbox (~80%), website contact form (~20%)                                          |
| Systems        | Storefront + order DB, payment processor, shipping carrier tracking, a Google Doc "help center" |

## 2. Stakeholders interviewed (simulated)

- **VP Customer Experience (sponsor):** wants faster responses and lower cost per ticket without hurting CSAT.
- **Support Lead:** wants agents freed from repetitive "where is my order" work; worried about the AI giving wrong refunds.
- **Finance Controller:** refunds must follow policy; anything above a threshold needs human sign-off and an audit trail.
- **Head of Engineering (2 devs):** no capacity to maintain complex infra; wants it secure, observable, cheap.
- **Legal/Privacy:** customers must know they're talking to an AI; personal data retention must be limited.

## 3. Current state and pain points

**Ticket volume:** ~6,500 tickets/month (~215/day; peaks of ~450/day in November–December).

| Category                                   | Share | Typically resolvable without a human? |
| ------------------------------------------ | ----- | ------------------------------------- |
| Order status / "where is my order" (WISMO) | 34%   | Yes — lookup + tracking               |
| Returns & refund policy questions          | 18%   | Yes — knowledge base                  |
| Refund / duplicate charge / damaged item   | 14%   | Partly — within policy limits         |
| Address / order changes before shipping    | 9%    | Yes — if not yet shipped              |
| Product questions                          | 8%    | Mostly — knowledge base               |
| Spam, newsletters, auto-replies            | 10%   | Yes — close without reply             |
| Complaints, complex or legal               | 7%    | No — human                            |

**Pain points**

1. **Slow first response:** median first-response time is **9.5 hours**; weekends exceed 30 hours. Customers send follow-ups, which creates duplicate tickets.
2. **Repetitive work:** about 60% of agent time goes to lookups that copy data from the order system into an email.
3. **Inconsistent answers:** the policy doc is out of date, so agents answer the same question differently.
4. **Refund leakage:** refunds are granted inconsistently, and there's no audit trail of who approved what and why.
5. **Peak-season hiring:** 4 temporary agents are hired each holiday season (~$40k), with long ramp-up time.
6. **No metrics:** CSAT is measured ad hoc; no one knows cost per ticket or the resolution rate.

**Current cost baseline:** ~$7.80 per ticket (fully loaded agent cost ÷ tickets), averaging **8 minutes of agent handling time** per ticket.

## 4. Goals, success criteria and target KPIs

| KPI                                   | Baseline       | 90-day target                                  | How measured                      |
| ------------------------------------- | -------------- | ---------------------------------------------- | --------------------------------- |
| Auto-resolution rate (no human touch) | 0%             | **≥ 50%** of non-spam tickets                  | Ticket status + audit log         |
| Median first-response time            | 9.5 h          | **< 2 min** (AI) / < 4 h (escalated)           | Ticket timestamps                 |
| Cost per ticket                       | $7.80          | **< $3.50** blended                            | Model cost + human minutes × rate |
| CSAT                                  | ~78% (sampled) | **≥ 80%** (no regression)                      | Rating link in replies            |
| Policy compliance on refunds          | unknown        | **100%** within limits; 0 unauthorized refunds | Code-enforced rules + audit log   |
| Escalation precision                  | n/a            | ≥ 90% of escalations judged necessary          | Weekly human review sample        |
| Agent hours saved                     | —              | ≥ 400 h/month                                  | Auto-resolved × 8 min             |

## 5. Requirements

**Functional**

- Ingest email (Gmail) and website chat; thread follow-ups into the same ticket.
- Classify intent, urgency, sentiment and language; identify the customer.
- Investigate with tools: customer profile, orders, ticket history, knowledge base (cited).
- Act within policy: answer questions, update the address if not shipped, issue refunds/replacements up to an auto-approve limit.
- Reply in the customer's language and the brand voice; disclose that the replier is an AI and offer a human.
- Escalate with a summary, findings, reason and a suggested reply when uncertain, the customer is upset, a request is outside policy, an amount exceeds the threshold, or the customer asks for a human.
- Dashboard: ticket queue, trace view, approve/edit/reject escalations, rollout mode, limits, kill switch, metrics.

**Non-functional**

- Security per OWASP Top 10 for LLM Applications; tenant isolation; full audit log.
- $0 infrastructure for the pilot (free tiers only).
- Every agent action traceable; failures never silently dropped.
- Model-agnostic: the model can be swapped by configuration.

## 6. Constraints

- **Budget:** $0 for the pilot — free tiers only, no credit card.
- **Team:** 2 developers with limited time → managed services, minimal ops.
- **Data:** synthetic data only during the pilot; no real customer PII leaves the client's systems.
- **Compliance:** AI disclosure in every reply; data retention ≤ 90 days for message bodies.

## 7. Risks

| Risk                                    | Impact                  | Mitigation                                                                     |
| --------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| AI issues unauthorized or wrong refunds | Financial loss          | Limits enforced in code; model only _requests_; human approval above threshold |
| Prompt injection via email              | Data leak / bad actions | Inbound content treated as data; detection + flagging; output validation       |
| Hallucinated policy answers             | Wrong commitments       | RAG with citations; escalate when retrieval confidence is low                  |
| Free-tier rate limits during peaks      | Delayed replies         | Provider fallback (Gemini → Groq), queue + retries, usage alerts               |
| Email reply loops / spam floods         | Reputation, quota burn  | Loop detection, sender caps, rate limits, kill switch                          |
| Agent trust / adoption                  | Low usage               | Phased rollout: shadow → draft-only → auto-send, with metrics at each gate     |

## 8. Scope

**In scope (pilot):** email + web chat channels; order-status, returns, refund, address-change and product-question flows; escalation workflow; dashboard; evaluation suite; two tenants (Harbor & Pine, plus a SaaS demo tenant proving multi-tenancy).

**Out of scope (pilot):** voice/phone, social media DMs, real payment-processor refunds (simulated), real carrier APIs (simulated tracking), helpdesk migration (Zendesk/Intercom adapters documented, not built), SSO for the dashboard.

## 9. Second tenant (multi-tenancy proof)

**Cadence Analytics** — a fictional B2B SaaS analytics product. Different policies: no physical orders; issues are billing (prorated refunds, auto-approve limit $50), plan changes, password/login help (always routed to secure self-service, never handled in chat), and bug reports (escalated to engineering). Formal, concise brand voice vs. Harbor & Pine's warm, friendly tone.
