# Handoff: Harbor & Pine support agent

_For the client's support lead, engineering lead and operations owner. Fictional client; v1.0, 2026-11-05._

## 1. What you're getting

| Delivered                          | Where                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Live agent on email + website chat | https://ai-support-ops-agent.vercel.app (Gmail polled every 2 min; chat on the site)                                   |
| Operations dashboard               | `/dashboard`: queue, traces, approvals, settings, kill switch, business metrics, usage                                 |
| Second client already configured   | Cadence Analytics, proving a new client is configuration only ([ONBOARDING_RUNBOOK.md](ONBOARDING_RUNBOOK.md))         |
| Quality gate                       | 47-case eval suite, report, and a CI gate that blocks unsafe or untested prompt changes ([evals/](../evals/README.md)) |
| Security review                    | [THREAT_MODEL.md](THREAT_MODEL.md) (STRIDE + OWASP LLM Top 10, abuse cases, residual risks)                            |
| Operations docs                    | [DEPLOYMENT.md](DEPLOYMENT.md) (runbook, rollback, checks), [DECISIONS.md](DECISIONS.md) (26 ADRs)                     |

## 2. How it behaves (what to tell your team)

- It **answers** order status, returns and shipping policy, duplicate-charge refunds within your limit, and address changes before shipping. It replies in English, Spanish or French, in your brand voice, and always says it's an AI and how to reach a person.
- It **escalates** to your queue with a summary, the evidence and a draft reply when:
  - a refund is over $75, or it's the customer's third refund in 30 days;
  - the customer asks for a human, is very upset, or mentions legal or safety;
  - it isn't confident;
  - the message looks like a manipulation attempt;
  - the help center doesn't cover the question.
- It **never**:
  - acts for someone who hasn't proven who they are (email sender authentication, or order number + email in chat);
  - touches another customer's order;
  - takes more than one account action per ticket;
  - sends a link outside your allowed domains;
  - claims to have done something it didn't do.

  Code enforces all of these, whatever the model says.

## 3. Daily and weekly operations

**Daily (5 minutes, support lead)**

- Dashboard → Escalations: approve, edit or reject drafts. Approving a refund draft runs the refund first, then sends the reply.
- Glance at the Overview: escalation rate and "needs attention" count.

**Weekly (30 minutes, support lead + one agent)**

- Review a sample of 20 auto-sent replies in the trace view (what the agent looked up, which policy it used, why it replied). Report wrong answers as eval cases.
- Check the business metrics against the targets: auto-resolution ≥ 50%, first response < 2 min, cost < $3.50 per ticket, CSAT ≥ 80%.
- Look at "injection attempts flagged" and "spam closed" for unusual spikes.

**Monthly (engineering)**

- Merge dependency updates (Dependabot PRs) after CI passes.
- `npm run eval` on the production models after any prompt or policy change (CI enforces this for prompts).

## 4. When something goes wrong

| Symptom                                      | First step                                                                                  | Details                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- |
| The agent says something wrong or unsafe     | **Kill switch** (Dashboard → Settings). Tickets keep flowing to humans                      | Then review the trace                   |
| Emails not answered                          | Check the last poll result (SQL in DEPLOYMENT.md "Checks"), then Gmail authorization        | Alert email after 3 failures in an hour |
| "Needs attention" tickets                    | A run crashed or a send failed after an action ran. Handle manually; nothing was sent twice | ADR-017                                 |
| Chat says "couldn't confirm you're a person" | Normal for bots. For real visitors, check the Turnstile widget hostname                     | ADR-021                                 |
| Free-tier limits hit                         | Replies fall back to the next model; if all are exhausted, tickets go to humans             | ADR-015, ADR-022                        |
| Bad deploy                                   | Vercel → Deployments → previous → Promote to Production (instant)                           | DEPLOYMENT.md                           |

Failure alerts go to the owner's email (`ALERT_EMAIL`) **and** as a phone push through the ntfy app (`ALERT_NTFY_TOPIC`), on the 3rd failure of a kind in a clock hour and at most once an hour. If Gmail itself is down, the push still arrives (ADR-026).

## 5. Access, secrets and rotation

- **Dashboard access:** invite-only magic links (`npm run dashboard:users`). There are no passwords to leak. The public demo viewer sees fictional data on demo tenants only (RLS; ADR-018, ADR-025).
- **Secrets:** the macOS Keychain is the source of truth. They're copied to Vercel (`secrets push-vercel`) and Supabase Vault (`secrets push-supabase-vault`), and never committed or printed. Rotate one by setting it again in the Keychain (`npm run secrets set NAME`), pushing, and redeploying. Rotate `CRON_SECRET` in both Vercel and Vault together.
- **Who owns what:** Vercel, Supabase, Google Cloud (Gmail OAuth app), Groq, Gemini API and Cloudflare (Turnstile) accounts. Transfer each to the client's own accounts before going beyond the pilot (section 7).

## 6. Known limits (honest list)

- **Free tiers:**
  - Groq's free models have small per-minute and daily token limits.
  - Gemini's free tier trains on prompts, so email avoids it (ADR-020).
  - Busy periods can mean slower replies or more escalations.
- **Simulated integrations:** refunds and tracking run against the demo database, not a real payment processor or carrier. Swapping in real APIs means replacing two tools behind the same policy checks.
- **The action-claim check is pattern-based:** it checks the action type, not the amount (ADR-023). Human review and the eval judge are the backstops.
- **Email retrieval is keyword-only** (no-training rule), so it can miss a help-center article when the customer uses very different words. Chat also uses vector search.
- **Gmail OAuth app is unverified:** fine for one inbox (under 100 users). Production at scale needs Google's verification.
- **Eval results for the larger Gemini Flash models and gpt-oss-120b are pending** (free-tier quota). They're added to the report as they complete.

## 7. Moving beyond the pilot

| Step                                            | Why                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Paid model tier (Groq or Anthropic) for email   | Removes free-tier limits; Groq gpt-oss-20b costs $0.0005 per ticket at list price, about $3/month at 6,500 tickets |
| Paid Supabase and Vercel plans                  | Backups, higher limits, no pause risk (check current pricing)                                                      |
| Real refund and carrier APIs                    | Behind the same `issue_refund` / tracking tool interfaces and policy engine                                        |
| Google OAuth verification, or a Workspace inbox | Removes the unverified-app warning                                                                                 |
| An external uptime monitor                      | Detects a fully down site even when no failure is logged                                                           |
| The client's own eval cases from real tickets   | Measures quality on their actual mix before widening auto-send                                                     |

## 8. Contacts

| Role                       | Contact (fictional engagement)        |
| -------------------------- | ------------------------------------- |
| Engagement owner / builder | ivklinsy@gmail.com                    |
| Client sponsor             | VP Customer Experience, Harbor & Pine |
| Client operations owner    | Support Lead, Harbor & Pine           |
