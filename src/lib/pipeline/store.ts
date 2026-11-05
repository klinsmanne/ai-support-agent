import type { AgentResult, ConversationTurn } from "../agent/orchestrator.ts";
import type { ChannelId } from "../channels/types.ts";
import type { TenantSettings } from "../tenants/config.ts";

/** Persistence the ticket pipeline needs. Implemented for Supabase (prod) and in memory (tests). */

export interface TicketRef {
  id: string;
  status: string;
  customerId: string | null;
  aiReplyCount: number;
  created: boolean;
  firstResponseAt: string | null;
}

export type MessageStatus =
  "received" | "draft" | "pending_approval" | "sent" | "rejected" | "failed";

export interface PipelineStore {
  tenantIdBySlug(slug: string): Promise<string | null>;
  settings(tenantId: string): Promise<TenantSettings & { kill_switch: boolean }>;
  /**
   * Idempotency: true only for the first caller with this provider message id. Never true again,
   * even after a failure — a re-run could send a second reply; failures go to a human instead.
   */
  claimMessage(provider: string, providerMessageId: string, tenantId: string): Promise<boolean>;
  finishMessage(
    provider: string,
    providerMessageId: string,
    status: "done" | "skipped" | "failed",
    ticketId: string | null,
    error?: string,
  ): Promise<void>;
  findCustomerIdByEmail(tenantId: string, email: string): Promise<string | null>;
  findOrCreateTicket(
    tenantId: string,
    channel: ChannelId,
    threadKey: string,
    init: {
      customerId: string | null;
      requesterEmail: string | null;
      subject: string | null;
      senderVerified: boolean;
    },
  ): Promise<TicketRef>;
  addMessage(
    tenantId: string,
    ticketId: string,
    m: {
      direction: "inbound" | "outbound";
      author: "customer" | "ai" | "human" | "system";
      status: MessageStatus;
      body: string;
      providerMessageId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<string>;
  conversation(tenantId: string, ticketId: string): Promise<ConversationTurn[]>;
  saveRun(
    tenantId: string,
    ticketId: string,
    triggerMessageId: string,
    result: AgentResult,
  ): Promise<string>;
  updateTicket(tenantId: string, ticketId: string, patch: Record<string, unknown>): Promise<void>;
  createEscalation(
    tenantId: string,
    ticketId: string,
    e: {
      runId: string | null;
      reasonCodes: string[];
      summary: string;
      investigation: unknown;
      suggestedReply: string | null;
      pendingAction?: unknown;
    },
  ): Promise<string>;
  audit(
    tenantId: string,
    e: {
      actorType: "ai" | "human" | "system";
      actorId?: string;
      action: string;
      entityType: string;
      entityId?: string;
      reason?: string;
      details?: unknown;
    },
  ): Promise<void>;
  /** Atomic fixed-window rate limit; true = allowed. */
  rateLimit(key: string, windowSeconds: number, max: number): Promise<boolean>;
  ticketsCreatedToday(tenantId: string): Promise<number>;
  addUsage(provider: string, metric: string, value: number): Promise<void>;
  /** Messages stuck in "processing" (crashed/timed-out run) → failed + ticket needs_attention. */
  sweepStale(olderThanMinutes: number): Promise<number>;
  channelState(tenantId: string, channel: ChannelId): Promise<Record<string, unknown>>;
  setChannelState(
    tenantId: string,
    channel: ChannelId,
    state: Record<string, unknown>,
  ): Promise<void>;
  /** Atomically claim the channel for `seconds` (one poll at a time); false = someone holds it. */
  claimChannelLease(tenantId: string, channel: ChannelId, seconds: number): Promise<boolean>;
  releaseChannelLease(tenantId: string, channel: ChannelId): Promise<void>;
}
