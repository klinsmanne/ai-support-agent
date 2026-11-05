# How to use your agent (beginner guide)

Everything you do day to day happens in the dashboard. No terminal needed, except to add a brand-new client (the last section).

## Sign in

- **You (the owner):** go to https://ai-support-ops-agent.vercel.app/login, type your email and press **Email me a sign-in link**. Open the email and click the link. There's no password.
- **Anyone else, read-only:** **View demo dashboard (read-only)** on the same page opens the demo with fictional data, with no sign-up.
- **Your client's team:** invite them to _their_ company only (ask Claude Code to run `npm run dashboard:users -- name@client.com --tenant client-slug --role agent`). Roles for a client's team:
  - `owner` can change settings;
  - `agent` can approve replies;
  - (`viewer` is only for the public read-only demo.)

At the top, the tabs (Harbor & Pine, Cadence Analytics) switch between companies. You only see companies you're a member of.

## Overview: is it working?

The first page shows the business numbers for the last 7, 30 or 90 days:

| Number                                   | What it means                                             | Target (from discovery) |
| ---------------------------------------- | --------------------------------------------------------- | ----------------------- |
| Auto-resolution rate                     | Tickets the AI fully handled                              | ≥ 50%                   |
| Escalation rate                          | Tickets handed to a person                                | —                       |
| Median first response                    | How fast customers got the first reply                    | < 2 min                 |
| Agent hours saved                        | 8 min per auto-resolved ticket, 4 min per approved draft  | ≥ 400 h/month           |
| Cost per ticket                          | AI cost plus human time, against the $7.80 human baseline | < $3.50                 |
| CSAT                                     | Customer ratings from the link in replies                 | ≥ 80%                   |
| Spam closed / injection attempts flagged | Junk filtered out and manipulation attempts caught        | —                       |

Below that is **Free-tier usage today**: how much of each free AI allowance is used. Near the limit it warns you, and the system switches to other models by itself.

## Tickets: what happened to each conversation

**Tickets** lists every conversation. Filter by status or channel, or search by subject, email or intent. Click one to see:

- the full conversation;
- the **agent trace**, step by step: what the AI understood, which tools it used and what they returned, which help-center articles it found, which rules it checked, and why it replied or escalated. Use this when someone asks "why did the AI say that?".

Statuses: `new` → `in progress` → `awaiting customer` → `resolved` / `escalated` / `closed`. **`needs attention`** means something failed and a person should look. Nothing is ever silently dropped.

## Escalations: your to-do list

**Escalations** holds tickets waiting for a person. Each shows:

- why it escalated (for example "refund above limit", "customer asked for a human", "suspected prompt injection");
- a summary and what the AI found;
- a **suggested reply** you can edit.

Then choose:

- **Approve & send.** It sends the reply (edited or not). If the draft includes a refund or address change, that runs **first**, then the reply goes out.
- **Reject — I'll handle it.** Nothing is sent, and you reply to the customer yourself.

## Get notified about escalations

In **Settings → Notifications**, enter your team's email address:

- **Right away:** urgent escalations arrive by email. That covers a customer asking for a person, a very upset customer, legal or safety issues, refunds above the limit, and manipulation attempts.
- **Every morning (13:00 UTC, which is 7 am US Central in winter and 8 am in summer):** a digest lists everything still waiting, oldest first.

Each email has the reason, a short summary and a link straight to the ticket, never the customer's message itself. Leave the address empty to turn notifications off.

## Settings: how much the AI may do

Only owners can change these. They take effect on the next ticket:

- **Rollout mode:**
  - **Shadow:** the AI drafts, nothing is sent. Use it for the first week with a new client.
  - **Draft-only:** every reply waits for your approval.
  - **Auto-send:** confident, in-policy replies go out by themselves, and everything else still comes to Escalations.
- **Kill switch:** stops all AI replies immediately. Tickets still arrive and wait for people. Use it if anything looks wrong, then look at the traces.
- **Limits:**
  - the refund amount the AI may approve by itself;
  - refunds per customer per 30 days;
  - how upset a customer may be before a person takes over;
  - the minimum confidence needed to answer;
  - the daily ticket cap;
  - the maximum AI replies per conversation.

## Try it like a customer

- **Chat:** on the landing page, under "Try it", click a scenario, then **Send**. Tick "Verify you are human" if asked.
- **Email:** click **Send a demo email** and send it from your own email. The reply arrives within a few minutes, because the inbox is checked every 2 minutes.
- Then find the conversation in **Tickets** and open its trace.

## Add a new client

Open Claude Code in the project folder and type:

```
/onboard-customer new-client-name
```

It asks you about the client's policies one question at a time, builds the configuration, and checks with you before touching the live system. It starts the client in **Shadow** mode. The full process is in [ONBOARDING_RUNBOOK.md](../ONBOARDING_RUNBOOK.md).
