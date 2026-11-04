/**
 * Channel adapter contract. Email (Gmail) and web chat are implemented; a Zendesk, Slack or
 * Intercom adapter implements the same two shapes (normalize inbound → InboundMessage, deliver
 * OutboundReply) and plugs into the same pipeline — see docs/SOLUTION_DESIGN.md §2.
 */

export type ChannelId = "email" | "chat";

export interface SenderAuth {
  /** Results parsed from Authentication-Results (email) or the chat verification step. */
  spf: "pass" | "fail" | "none" | "unknown";
  dkim: "pass" | "fail" | "none" | "unknown";
  dmarc: "pass" | "fail" | "none" | "unknown";
  /**
   * The From domain itself is authenticated: DMARC passed, or SPF/DKIM passed for a domain
   * aligned with From. Plain spf=pass + dkim=pass only proves the *attacker's* domain.
   */
  aligned: boolean;
}

export interface InboundMessage {
  channel: ChannelId;
  /** Provider-unique id (Gmail message id, chat message uuid) — the idempotency key. */
  providerMessageId: string;
  /** Groups messages into one ticket (Gmail threadId, chat session id). */
  threadKey: string;
  from: { email: string | null; name: string | null };
  /** Addresses the message was sent to (tenant routing for email). */
  to: string[];
  subject: string | null;
  /** Plain text with quoted history removed. */
  text: string;
  receivedAt: string;
  auth: SenderAuth;
  /** Email headers needed for threading and loop detection (lower-cased keys). */
  headers: Record<string, string>;
}

export interface OutboundReply {
  channel: ChannelId;
  threadKey: string;
  to: string;
  subject: string | null;
  body: string;
  /** RFC 5322 Message-ID of the message being answered (email threading). */
  inReplyTo?: string | null;
  references?: string | null;
}

export interface ChannelSender {
  send(reply: OutboundReply): Promise<{ providerMessageId: string }>;
}
