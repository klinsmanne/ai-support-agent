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

## 10. Competitive landscape and SWOT (retrospective)

_Added 2026-11-12, after the initial build, as a retrospective review. Sections 1 to 9 are the original discovery and are unchanged. Vendor facts come only from each vendor's own public pages, read on 2026-11-12 (sources below). Prices change often, so check them again before any purchase decision. Anything those pages did not state is marked "not stated" or left out._

### Alternatives compared

| Option                        | Who it targets                                                                   | Pricing (as published)                                                                                                                                                        | Resolves or drafts                                                           | Refunds and other actions                                                                                                                                           | Rollout risk controls                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Zendesk AI agents [Z]         | Support teams on Zendesk. AI agents are included in every Suite and Support plan | Seats $19 to $115 per agent a month (annual). Automated resolutions $1.50 committed or $2.00 pay-as-you-go, 5 to 10 included per agent a month. Copilot $50 per agent a month | Both: AI agents resolve end to end, Copilot and Auto Assist draft for agents | Through APIs, MCP and integrations (integration builder, custom actions). Refunds not named                                                                         | Scenario tests before deployment, A/B tests, QA review, sandbox on Enterprise, handoff with context                    |
| Intercom Fin [I]              | Software, retail and regulated industries. Plans from startups to large teams    | $0.99 per outcome, 50 a month minimum. Runs on other helpdesks with no seats. Copilot is a separate add-on                                                                    | Both: Fin resolves, Copilot helps agents                                     | Says it "processes payments and refunds" through APIs, data connectors, MCP and multi-step Procedures. Approval steps not stated                                    | Simulations, regression tests, previews, audience testing, usage alerts and limits, handoff to the inbox               |
| Gorgias AI Agent [G]          | Ecommerce, mainly Shopify brands                                                 | Helpdesk priced by ticket volume (50 to 5,000 a month), not per agent. AI Agent $0.90 per automated interaction (annual) or $1.00 (monthly)                                   | Resolves without a human. Drafting for agents not stated                     | Automates "returns, order tracking" and order management. Limits and approvals not stated                                                                           | Not stated on the pages reviewed (a 7-day trial is offered)                                                            |
| Freshdesk Freddy AI Agent [F] | Support teams on Freshdesk, plans from Growth (email) to Enterprise              | Seats $19 to $89 per agent a month (annual). 500 free AI Agent sessions once per account, then $49 per 100. Copilot $29 per agent a month                                     | Resolves end to end. Copilot is an add-on (its function not described)       | Connects to backend systems to "process refunds, update orders". Prebuilt workflows for Shopify, Stripe, FedEx. Approvals not stated                                | "Roll-out controls" for the email agent (not detailed), sandbox on Enterprise, escalation with full context            |
| Decagon [D]                   | Large enterprises (airlines, fintech, telecom, retail)                           | Not published. Sold through sales                                                                                                                                             | Resolves end to end                                                          | Workflows written in natural language (AOPs) that call support tools. Says refunds run "with strict controls" without describing them                               | Simulations before deploying and on every update, CI/CD tests, A/B tests of versions, monitoring (Watchtower)          |
| Sierra [S]                    | Large consumer brands, including retail ("40% of the Fortune 50", per Sierra)    | Outcome-based, with criteria agreed per customer. Escalations usually not charged. No public rate card                                                                        | Resolves end to end, hands off to people                                     | Integrations with order and CRM systems. Says these interactions are "deterministic and controlled". Refund limits not described                                    | Simulations, regression tests, supervisory layers around the model, decision traces                                    |
| **This agent (built)**        | One mid-size retailer and one SaaS client, both fictional                        | $0 on free tiers. Model cost $0.0005 to $0.0026 per ticket at paid list prices (ADR-022). Paid hosting and upkeep not costed                                                  | Either, per client: auto-send, draft-only or shadow (M7)                     | 2 write tools. Refund cap and 30-day count checked in code and again in one database transaction, 1 action per ticket, a human approves above the cap (M4, ADR-012) | Shadow, then draft-only, then auto-send, a kill switch, a 47-case eval gate in CI, every step traced (M7, M8, ADR-022) |

**What the review shows:** every vendor sells end-to-end resolution, pre-launch testing of some kind and handoff to people, so those are the baseline, not a reason to build. Published prices are per resolution or outcome ($0.90 to $2.00 where listed) or negotiated. None of the pages reviewed describe a hard refund limit or approval step enforced outside the model. That doesn't mean the products lack one, only that a buyer would have to confirm it in a demo.

### SWOT: building this agent instead of buying

| Strengths                                                                                                                                                                                                                                                                                                                                                                                                | Weaknesses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refund and order rules are code and SQL the client can read and test, not vendor settings (M4, ADR-012). Quality was measured before launch: 47 eval cases, 0 safety failures on both production models (ADR-022). No per-resolution fee. Traces and data stay in the client's own database, and email goes only to providers that don't train on it (ADR-020). New clients are configuration only (M9). | Tested only against two fictional demo clients (Harbor & Pine Home Goods and Cadence Analytics), with no real customer traffic, so auto-resolution, CSAT and escalation precision are unmeasured on real tickets. Runs on free tiers with daily quotas and no SLA (ADR-010, ADR-015). Maintained by one person. Fewer channels and integrations than any vendor: email and chat only, simulated refunds and carrier tracking, no helpdesk, no SSO. The claim check is pattern-based and doesn't compare amounts (ADR-023). |
| **Opportunities**                                                                                                                                                                                                                                                                                                                                                                                        | **Threats**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Run shadow mode on the client's real traffic to measure auto-resolution before paying anyone (BUSINESS_CASE §6), which also gives a fair baseline to judge vendors against. Sit behind the client's helpdesk through the channel adapter interface instead of replacing it (PRD could-have, CHANNEL_ADAPTERS.md). The policy layer and eval suite are reusable, including to test a bought tool.         | Vendors have larger teams and already cover what this pilot lists as non-goals (voice, social, prebuilt store actions). Free-tier quotas, terms or models can change without notice, and paid tiers end the $0 case. One maintainer is a single point of failure for a system that moves money. Security and compliance work stays with the builder. The client has 2 developers with no spare capacity (§2), so long-term ownership is open.                                                                              |

### What to build and why

Building does not win on breadth: every vendor covers more channels and integrations. It earns a place on what discovery ranked highest, the support lead's fear of wrong refunds and finance's demand for in-policy, audited refunds, and on the $0 pilot budget (§6). So the pilot builds the narrow part where control matters:

- Business rules are enforced in code and in the database, not in the prompt (M4, ADR-012). Refunds are capped ($50 by default, $75 for Harbor & Pine), limited to 2 per customer in 30 days and to one account action per ticket.
- Escalation rules send a ticket to a person when a refund is over the limit, the customer is upset or asks for a human, confidence is low, there is a legal or safety issue, or injection is suspected. Urgent ones are emailed to the team (M5, ADR-027).
- A reply may claim only actions that code performed (M6, ADR-023).
- Shadow, draft-only and auto-send rollout with a kill switch lets each client grant autonomy on evidence (M7, SOLUTION_DESIGN §7).

The non-goals (voice and social, real payment and carrier integrations, helpdesk migration, SSO) are where vendors are strongest, so the pilot does not compete there. The next step is shadow mode on real traffic. If a bought tool meets the same refund-control and eval bar at an acceptable price, buying it, or putting this agent behind the client's helpdesk, is a valid outcome.

**Sources (vendor pages, read 2026-11-12):**

- [Z] [zendesk.com/pricing](https://www.zendesk.com/pricing/), [AI agents](https://www.zendesk.com/service/ai/ai-agents/), [automated resolutions](https://support.zendesk.com/hc/en-us/articles/5352026794010-About-automated-resolutions-for-AI-agents), [integration builder](https://support.zendesk.com/hc/en-us/articles/8357756844442-About-the-integration-builder-for-advanced-AI-agents)
- [I] [fin.ai/pricing](https://fin.ai/pricing), [fin.ai](https://fin.ai/), [intercom.com/pricing](https://www.intercom.com/pricing)
- [G] [gorgias.com/pricing](https://www.gorgias.com/pricing), [AI Agent](https://www.gorgias.com/ai-agent)
- [F] [Freshdesk pricing](https://www.freshworks.com/freshdesk/pricing/), [Freddy AI Agent](https://www.freshworks.com/freshdesk/omni/freddy-ai-agent/)
- [D] [decagon.ai](https://decagon.ai/), [product overview](https://decagon.ai/product/overview), [AOPs](https://decagon.ai/product/aop), [testing](https://decagon.ai/product/testing-qa), [Watchtower](https://decagon.ai/product/watchtower)
- [S] [sierra.ai](https://sierra.ai/), [product](https://sierra.ai/product), [outcome-based pricing](https://sierra.ai/blog/outcome-based-pricing-for-ai-agents), [Agent Studio](https://sierra.ai/product/agent-studio), [trust and reliability](https://sierra.ai/product/trust-and-reliability), [retail](https://sierra.ai/industries/retail)
