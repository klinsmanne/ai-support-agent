# Onboarding Runbook: adding a new client

How to take a new client from "we'd like to try it" to "the agent answers our customers", safely. Each client (tenant) is one folder of configuration: no code changes and no new deployment. Cadence Analytics was added this way to prove it (a SaaS company with different policies, a different voice and a different rollout mode from Harbor & Pine).

Time: about a day of work, plus 2–4 weeks of staged rollout.

## 0. Before you start

- Discovery is done (template: [DISCOVERY.md](DISCOVERY.md)): ticket mix, policies, refund limits, escalation rules, languages, brand voice, retention requirement, target KPIs.
- Agree the **success gates** for each rollout stage (step 6) with the client's sponsor and support lead, in writing.
- The client names: a dashboard owner (email), the support inbox address, and the domains replies may link to.

## 1. Create the tenant folder

```
tenants/<client-slug>/
  tenant.json     # settings, demo customers/orders (validated by tenants/tenant.schema.json)
  kb/*.md         # help-center articles, one topic per file
```

Copy `tenants/cadence-analytics/` as a starting point. Settings that matter most:

| Setting                                         | What it controls                                                    | Typical first value                    |
| ----------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------- |
| `rollout_mode`                                  | `shadow` (nothing sent), `draft_only` (human approves), `auto_send` | **`shadow`**                           |
| `refund_auto_approve_limit_cents`               | Above this, a refund always waits for a human                       | Client's current agent limit, or lower |
| `max_refunds_per_customer_30d`                  | Frequency limit (stops repeat-refund abuse)                         | 1–2                                    |
| `enabled_tools`                                 | Which actions exist for this client at all                          | Remove `update_order` if not needed    |
| `escalate_on_negative_sentiment_below`          | How upset a customer can be before a human takes over               | −0.5 (cautious) to −0.85               |
| `min_confidence_to_act`                         | Below this, policy questions without a help-center source escalate  | 0.8 to start                           |
| `allowed_link_domains`                          | The only domains a reply may link to                                | Client's site + carrier/status page    |
| `supported_languages`, `brand_voice`            | Reply languages and tone                                            | From discovery                         |
| `daily_ticket_cap`, `max_ai_replies_per_thread` | Cost and loop protection                                            | 150 / 4                                |
| `retention_days`                                | When finished tickets are deleted (ADR-019)                         | From the client's privacy policy       |
| `demo`                                          | Only `true` for fictional showcase tenants (nightly demo reset)     | **`false`** for a real client          |

Help-center articles: plain Markdown, one topic per file, written the way the client would answer. They are the only source the agent may quote policy from.

## 2. Validate and generate the seed

```bash
npm run seed:build     # validates tenant.json against the schema and regenerates supabase/seed.sql
npm run check          # tests include tenant-config and seed checks
```

CI fails if `seed.sql` is out of sync with `tenants/*`, so the database always matches the committed configuration. For a real client (`"demo": false`), the seed only _inserts missing_ orders and customers. It never overwrites or deletes them (ADR-019).

## 3. Load it into the database and embed the knowledge base

```bash
supabase db push --remote --include-seed --yes   # migrations + seed
npm run kb:embed                                  # embeds new or changed help-center chunks
npm run kb:search -- "how do I return an item" <client-slug>   # check retrieval finds the right article
```

Asks first: this changes production data (CLAUDE.md, ADR-004).

## 4. Connect the channels

- **Email:** a support address routed to the shared inbox with plus-addressing (`support+<client-slug>@…`), or the client's own Gmail via `npm run gmail:auth` (Gmail OAuth app in production, see [DEPLOYMENT.md](DEPLOYMENT.md)). Sender authentication uses DMARC (ADR-016).
- **Chat:** the widget is already on the site. A client embed uses the same `/api/chat` with the tenant slug, and its hostname must be added to the Turnstile widget.

## 5. Give the client's team access

```bash
npm run dashboard:users   # invite owners/agents (magic-link sign-in, no passwords)
```

Roles: `owner` (settings, kill switch), `agent` (approve and edit drafts), `viewer` (read-only). RLS scopes every row to the tenant, so one client never sees another's data (ADR-009; tests in `tests/db/tenant-isolation.test.ts`).

## 6. Staged rollout (the important part)

| Stage         | Mode         | What happens                                                                | Move on when (example gates; agree real ones in step 0)                                    |
| ------------- | ------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1. Shadow     | `shadow`     | Agent runs on every ticket and writes a draft; **nothing is sent**          | 1 week; ≥ 90% of drafts the team would send as is; 0 policy violations in the trace review |
| 2. Draft-only | `draft_only` | Every reply waits in the approval queue; one click sends                    | 1–2 weeks; ≥ 80% approved without edits; escalation precision ≥ 90%; no wrong refund       |
| 3. Auto-send  | `auto_send`  | Confident, in-policy replies go out; everything else escalates with a draft | Ongoing; weekly sample review; CSAT not below baseline                                     |

Each stage is one setting on the dashboard's Settings page. The **kill switch** on the same page stops all AI replies immediately, and tickets keep flowing to humans.

Measure at each gate on the dashboard: auto-resolution rate, escalation rate, median first response, cost per ticket, agent hours saved, injection attempts, spam closed.

## 7. Run the client's own eval cases (recommended)

Add 10–20 cases from the client's real ticket mix (anonymized) to `evals/cases.ts`, run `npm run eval -- --model <primary>` and `npm run eval:report`, and add the results to the handoff. A failing case becomes a prompt, policy or help-center fix _before_ auto-send.

## 8. Offboarding

Set `rollout_mode` to `shadow` and turn on the kill switch. **Export** what the client needs, including refund and audit records, because deleting the tenant row removes _all_ of its data (tickets, messages, runs, traces, refunds and members cascade). Then delete the tenant, revoke the client's Gmail grant, and remove their hostname from the Turnstile widget.
