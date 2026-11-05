# Adding a channel (Zendesk, Slack, Intercom)

Email (Gmail) and website chat are built. Any other channel plugs into the same pipeline by implementing two small shapes from `src/lib/channels/types.ts`, so nothing in the agent, policy engine or guardrails changes.

## The contract

```ts
// Inbound: turn the provider's event into this, then call ingestMessage(msg, deps).
interface InboundMessage {
  channel: ChannelId; // add "zendesk" | "slack" | "intercom" to ChannelId
  providerMessageId: string; // the provider's unique id → idempotency key (at-most-once, ADR-017)
  threadKey: string; // groups messages into one ticket (Zendesk ticket id, Slack thread_ts…)
  from: { email: string | null; name: string | null };
  to: string[]; // used for tenant routing
  subject: string | null;
  text: string; // plain text, quoted history removed
  receivedAt: string;
  auth: SenderAuth; // how sure we are of the sender's identity (see below)
  headers: Record<string, string>;
}

// Outbound: deliver a validated reply.
interface ChannelSender {
  send(reply: OutboundReply): Promise<{ providerMessageId: string }>;
}
```

`ingestMessage` already does the rest:

- dedupe;
- spam, auto-reply and loop filtering;
- ticket threading;
- the agent run;
- output validation;
- rollout mode (shadow, draft or send);
- the audit log;
- "needs attention" on failure.

## Per provider

| Provider     | Inbound                                                                                                           | Outbound                                         | Sender identity (`auth.aligned`)                                                                      | Notes                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Zendesk**  | Webhook on "ticket comment added" (verify the `X-Zendesk-Webhook-Signature` HMAC); fetch the comment via API      | `PUT /api/v2/tickets/{id}` with a public comment | Zendesk's requester is authenticated by their end-user auth: treat as aligned only for verified users | `threadKey` = ticket id. Map Zendesk tags to our intents for reporting                   |
| **Slack**    | Events API (`message.channels` / `app_mention`), verify `X-Slack-Signature`; ack within 3 s, process in `after()` | `chat.postMessage` with `thread_ts`              | Slack user id → workspace member email via `users.info`                                               | `threadKey` = `thread_ts`; ignore bot and own messages (loop prevention)                 |
| **Intercom** | Webhook `conversation.user.replied` (verify `X-Hub-Signature`)                                                    | `POST /conversations/{id}/reply` as admin/bot    | Intercom identity verification (HMAC user hash) → aligned                                             | `threadKey` = conversation id; hand off by assigning to a team inbox instead of replying |

## Checklist for a new adapter

1. Add the id to `ChannelId`. The database enum `channel_type` needs a migration (it only adds things).
2. **Verify every webhook signature** before parsing. Reject replays: check the timestamp window, and rely on the provider message id dedupe.
3. Map the provider's identity proof to `SenderAuth.aligned`. **Unverified senders get general answers only**: account tools refuse them (the same rule as email DMARC).
4. Respond to the webhook quickly (most providers time out in a few seconds): acknowledge, then run the agent in `after()` or a queue. Today's routes run synchronously with a long `maxDuration` (chat 60 s, Gmail poll 300 s) because their callers can wait.
5. Add the provider's link domains to the tenant's `allowed_link_domains` if replies may reference them.
6. Tests: inbound normalization, signature rejection, dedupe on redelivery, and an end-to-end pipeline test with the in-memory store (see `tests/pipeline/pipeline.test.ts`).
7. Add eval cases for anything channel-specific (for example Slack's shorter, informal messages).
