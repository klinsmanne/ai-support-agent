import type { AgentRepo } from "../agent/domain.ts";
import { runAgent, type AgentResult } from "../agent/orchestrator.ts";
import { baseAddress, emailSkipReason, plusTag } from "../channels/email/filters.ts";
import type { ChannelSender, InboundMessage } from "../channels/types.ts";
import type { ModelRouter } from "../llm/router.ts";
import { maskPII } from "../guardrails/pii.ts";
import { reportFailure, type AlertSend } from "./alerts.ts";
import type { PipelineStore, TicketRef } from "./store.ts";
import { notifyUrgentEscalation, type TeamSend } from "./escalation-notify.ts";

/**
 * The ticket pipeline, shared by every channel:
 * route tenant → dedupe → filter loops/noise → verify sender → ticket (threaded, per sender)
 * → respect human ownership → rate limits → agent → persist run + trace → act per rollout mode
 * → audit. Nothing is dropped silently: failures end as `needs_attention` tickets, and a message
 * is never processed twice (so a crash can't cause a duplicate reply).
 */

export interface PipelineDeps {
  store: PipelineStore;
  repo: AgentRepo;
  router: Pick<ModelRouter, "generate">;
  classifierRouter?: Pick<ModelRouter, "generate">;
  /**
   * Agent dependencies for email: routers limited to providers that don't train on inputs and
   * a repo without third-party query embeddings (Gmail data, Google API Limited Use policy).
   * Falls back to the defaults when not provided (tests, scripts).
   */
  email?: {
    router: Pick<ModelRouter, "generate">;
    classifierRouter?: Pick<ModelRouter, "generate">;
    repo: AgentRepo;
  };
  sender: ChannelSender | null;
  /** Emails the operator about repeated failures (see alerts.ts); null = alerts off. */
  alert?: AlertSend | null;
  inboxAddress: string;
  defaultTenantSlug: string;
  /** Builds the public CSAT link for a ticket (optional). */
  csatUrl?: (ticketId: string) => string;
  /** Emails the client's team about urgent escalations (ADR-027); null = off. */
  notifyTeam?: TeamSend | null;
  /** Dashboard link for a ticket, used in notifications. */
  ticketUrl?: (ticketId: string) => string;
  now?: () => Date;
}

export type Delivery = "sent" | "draft" | "pending_approval" | "none";

export type IngestResult =
  | { status: "duplicate" }
  | { status: "skipped"; reason: string; ticketId: string | null }
  | { status: "rate_limited"; ticketId: string }
  | { status: "queued_for_human"; ticketId: string }
  | {
      status: "processed";
      ticketId: string;
      outcome: AgentResult["outcome"];
      delivered: Delivery;
      reply: string | null;
    }
  | { status: "failed"; ticketId: string | null; error: string };

const LIMITS = { perSenderPerHour: 6, perThreadPerHour: 8, globalPerMinute: 30 };

/** Ticket states owned by a human: new customer messages are attached, the AI doesn't step in. */
const HUMAN_OWNED = new Set(["escalated", "needs_attention"]);

const HOLDING_REPLY: Record<string, string> = {
  en: "Thanks for your message. A member of our team will review it and reply as soon as possible.",
  es: "Gracias por tu mensaje. Una persona de nuestro equipo lo revisará y te responderá lo antes posible.",
  fr: "Merci pour votre message. Un membre de notre équipe va l'examiner et vous répondra dès que possible.",
  de: "Danke für Ihre Nachricht. Ein Teammitglied prüft sie und antwortet so schnell wie möglich.",
};

export async function resolveTenant(
  msg: InboundMessage,
  deps: PipelineDeps,
): Promise<string | null> {
  if (msg.channel === "email") {
    // support+<slug-or-prefix>@ routes to that tenant; plain address → default tenant.
    const tag = plusTag(msg.to, deps.inboxAddress);
    if (tag) {
      const byTag =
        (await deps.store.tenantIdBySlug(tag)) ??
        (await deps.store.tenantIdBySlug(`${tag}-analytics`));
      if (byTag) return byTag;
    }
  }
  return deps.store.tenantIdBySlug(deps.defaultTenantSlug);
}

/**
 * Ticket key: chat = session; email = Gmail thread + sender, so a different person replying in
 * (or forwarding into) someone's thread never sees that customer's conversation history.
 */
export function ticketThreadKey(msg: InboundMessage): string {
  return msg.channel === "email" && msg.from.email
    ? `${msg.threadKey}|${baseAddress(msg.from.email)}`
    : msg.threadKey;
}

export async function ingestMessage(
  msg: InboundMessage,
  deps: PipelineDeps,
  opts: { tenantId?: string; chatVerifiedCustomerId?: string | null } = {},
): Promise<IngestResult> {
  const { store } = deps;
  const tenantId = opts.tenantId ?? (await resolveTenant(msg, deps));
  if (!tenantId) return { status: "failed", ticketId: null, error: "no tenant for message" };

  // 1. Idempotency: a provider message is processed at most once — never re-run after a crash.
  if (!(await store.claimMessage(msg.channel, msg.providerMessageId, tenantId))) {
    return { status: "duplicate" };
  }

  let ticketId: string | null = null;
  try {
    const settings = await store.settings(tenantId);
    const threadKey = ticketThreadKey(msg);

    // 2. Loop prevention / noise (email): never reply to ourselves, auto-replies, lists, bounces.
    const skip =
      msg.channel === "email"
        ? emailSkipReason(msg, [deps.inboxAddress])
        : msg.text.trim()
          ? null
          : "empty_body";
    if (skip) {
      const t = await store.findOrCreateTicket(tenantId, msg.channel, threadKey, {
        customerId: null,
        requesterEmail: msg.from.email,
        subject: msg.subject,
        senderVerified: false,
      });
      ticketId = t.id;
      await addInbound(deps, tenantId, t.id, msg);
      if (t.created) {
        await store.updateTicket(tenantId, t.id, {
          status: "closed",
          is_spam: true,
          intent: "auto_reply",
          closed_at: now(deps),
        });
      }
      await store.audit(tenantId, {
        actorType: "system",
        action: "message_skipped",
        entityType: "ticket",
        entityId: t.id,
        reason: skip,
      });
      await store.finishMessage(msg.channel, msg.providerMessageId, "skipped", t.id, skip);
      return { status: "skipped", reason: skip, ticketId: t.id };
    }

    // 3. Sender verification: on file AND (email) the From domain itself is authenticated.
    const emailAuthenticated = msg.channel === "chat" || msg.auth.aligned;
    const customerId =
      msg.channel === "chat"
        ? (opts.chatVerifiedCustomerId ?? null)
        : msg.from.email
          ? await store.findCustomerIdByEmail(tenantId, msg.from.email)
          : null;
    const senderVerified = !!customerId && emailAuthenticated;

    const ticket = await store.findOrCreateTicket(tenantId, msg.channel, threadKey, {
      customerId: senderVerified ? customerId : null,
      requesterEmail: msg.from.email,
      subject: msg.subject,
      senderVerified,
    });
    ticketId = ticket.id;
    const inboundId = await addInbound(deps, tenantId, ticket.id, msg);

    // 4. A human owns this ticket: attach the follow-up and let them know — the AI stays out.
    if (HUMAN_OWNED.has(ticket.status)) {
      await store.audit(tenantId, {
        actorType: "system",
        action: "customer_followup",
        entityType: "ticket",
        entityId: ticket.id,
        reason: `follow-up on ${ticket.status} ticket`,
      });
      await store.finishMessage(
        msg.channel,
        msg.providerMessageId,
        "done",
        ticket.id,
        "human_owned",
      );
      return { status: "queued_for_human", ticketId: ticket.id };
    }

    // Chat customers may verify mid-conversation: record it on the ticket.
    const reopen =
      !ticket.created && ["resolved", "awaiting_customer", "closed"].includes(ticket.status);
    await store.updateTicket(tenantId, ticket.id, {
      status: "in_progress",
      ...(reopen ? { resolved_at: null, closed_at: null, is_spam: false } : {}),
      ...(senderVerified && !ticket.customerId
        ? { customer_id: customerId, sender_verified: true }
        : {}),
    });

    // 5. Abuse protection: per-sender, per-thread and global rate limits plus the daily cap.
    const senderKey = msg.from.email ?? msg.threadKey;
    const allowed =
      (await store.rateLimit(`sender:${tenantId}:${senderKey}`, 3600, LIMITS.perSenderPerHour)) &&
      (await store.rateLimit(`thread:${tenantId}:${threadKey}`, 3600, LIMITS.perThreadPerHour)) &&
      (await store.rateLimit("global", 60, LIMITS.globalPerMinute)) &&
      (!ticket.created || (await store.ticketsCreatedToday(tenantId)) <= settings.daily_ticket_cap);
    if (!allowed) {
      await store.updateTicket(tenantId, ticket.id, { status: "needs_attention" });
      await store.audit(tenantId, {
        actorType: "system",
        action: "rate_limited",
        entityType: "ticket",
        entityId: ticket.id,
        reason: `sender ${maskPII(senderKey)}`,
      });
      await store.finishMessage(
        msg.channel,
        msg.providerMessageId,
        "done",
        ticket.id,
        "rate_limited",
      );
      return { status: "rate_limited", ticketId: ticket.id };
    }

    // 6. The agent.
    const conversation = await store.conversation(tenantId, ticket.id);
    const result = await runAgent(
      {
        tenantId,
        ticketId: ticket.id,
        channel: msg.channel,
        conversation,
        customerId: senderVerified ? customerId : null,
        customerEmail: msg.from.email,
        senderVerified,
        aiReplyCount: ticket.aiReplyCount,
        supportEmail: deps.inboxAddress,
        csatUrl: deps.csatUrl?.(ticket.id),
      },
      msg.channel === "email" && deps.email
        ? deps.email
        : { router: deps.router, classifierRouter: deps.classifierRouter, repo: deps.repo },
    );
    const runId = await store.saveRun(tenantId, ticket.id, inboundId, result);
    await recordUsage(deps, result);

    const c = result.classification;
    const triage = c
      ? {
          intent: c.intent,
          urgency: c.urgency,
          sentiment: c.sentiment,
          language: c.language,
          injection_suspected: result.injection.suspected,
        }
      : { injection_suspected: result.injection.suspected };
    const replyMeta = {
      inReplyTo: msg.headers["message-id"] ?? null,
      references: msg.headers["references"] ?? null,
    };
    // Only authenticated senders get mail from us: otherwise a forged From would make us email a
    // third party (backscatter). Their drafts wait for a human instead.
    const mayAutoSend = settings.rollout_mode === "auto_send" && emailAuthenticated;

    let delivered: Delivery = "none";
    let replyText: string | null = null;

    // 7. Act according to the outcome and the tenant's rollout mode.
    if (result.outcome === "closed_no_reply") {
      // A spam/auto-reply verdict only closes a brand-new ticket, never an existing conversation.
      await store.updateTicket(
        tenantId,
        ticket.id,
        ticket.created
          ? { ...triage, status: "closed", is_spam: true, closed_at: now(deps) }
          : { status: ticket.status === "new" ? "in_progress" : ticket.status },
      );
    } else if (result.outcome === "resolved" || result.outcome === "awaiting_customer") {
      replyText = result.reply!;
      if (mayAutoSend) {
        delivered = await deliver(deps, tenantId, ticket.id, msg, replyText, replyMeta);
        await store.updateTicket(
          tenantId,
          ticket.id,
          delivered === "sent"
            ? {
                ...triage,
                status: result.outcome,
                ai_reply_count: ticket.aiReplyCount + 1,
                ...(result.outcome === "resolved" ? { resolved_at: now(deps) } : {}),
                ...(ticket.firstResponseAt ? {} : { first_response_at: now(deps) }),
              }
            : { ...triage, status: "needs_attention" },
        );
      } else {
        // shadow: draft only for comparison; draft_only / unauthenticated: a human approves first.
        const needsApproval = settings.rollout_mode !== "shadow";
        delivered = needsApproval ? "pending_approval" : "draft";
        await store.addMessage(tenantId, ticket.id, {
          direction: "outbound",
          author: "ai",
          status: delivered,
          body: replyText,
          metadata: replyMeta,
        });
        if (needsApproval) {
          await store.createEscalation(tenantId, ticket.id, {
            runId,
            reasonCodes: [emailAuthenticated ? "draft_review" : "unauthenticated_sender"],
            summary: c?.summary ?? "AI draft awaiting approval",
            investigation: investigation(result),
            suggestedReply: replyText,
            // A draft that proposes a refund/address change carries it, so approval executes it.
            pendingAction: pendingActionOf(result),
          });
        }
        await store.updateTicket(tenantId, ticket.id, {
          ...triage,
          status: needsApproval ? "escalated" : "in_progress",
          ...(needsApproval ? { escalated_at: now(deps) } : {}),
        });
      }
    } else {
      // escalated / error: a human takes over with a summary and a suggested reply.
      const reasonCodes = result.escalation?.reasons ?? ["agent_error"];
      const summary = result.escalation?.summary ?? "Agent error";
      await store.createEscalation(tenantId, ticket.id, {
        runId,
        reasonCodes,
        summary,
        investigation: investigation(result),
        suggestedReply: result.escalation?.suggestedReply ?? null,
        pendingAction: pendingActionOf(result),
      });
      // Urgent escalations reach the team now; the rest wait for the daily digest (ADR-027).
      await notifyUrgentEscalation(store, deps.notifyTeam, {
        tenantId,
        brand: settings.brand_name,
        to: settings.escalation_notify_email,
        ticketId: ticket.id,
        reasons: reasonCodes,
        summary,
        ticketUrl: deps.ticketUrl?.(ticket.id),
      });
      // A short holding reply keeps first-response time low while a human reviews.
      if (
        mayAutoSend &&
        !settings.kill_switch &&
        ticket.aiReplyCount < settings.max_ai_replies_per_thread
      ) {
        const holding = HOLDING_REPLY[c?.language ?? "en"] ?? HOLDING_REPLY.en;
        delivered = await deliver(deps, tenantId, ticket.id, msg, holding, replyMeta);
        if (delivered === "sent") replyText = holding;
      }
      await store.updateTicket(tenantId, ticket.id, {
        ...triage,
        status: "escalated",
        escalated_at: now(deps),
        ...(delivered === "sent"
          ? {
              ai_reply_count: ticket.aiReplyCount + 1,
              ...(ticket.firstResponseAt ? {} : { first_response_at: now(deps) }),
            }
          : {}),
      });
    }

    for (const action of result.actions) {
      await store.audit(tenantId, {
        actorType: "ai",
        action: `${action.type}:${action.status}`,
        entityType: "order",
        entityId: action.orderNumber,
        reason: action.policy.join("; "),
        details: action,
      });
    }
    await store.audit(tenantId, {
      actorType: "ai",
      action: `ticket_${result.outcome}`,
      entityType: "ticket",
      entityId: ticket.id,
      reason: result.escalation?.reasons.join(", "),
      details: {
        runId,
        delivered,
        injection: result.injection,
        senderAuthenticated: emailAuthenticated,
      },
    });
    await store.finishMessage(msg.channel, msg.providerMessageId, "done", ticket.id);
    return {
      status: "processed",
      ticketId: ticket.id,
      outcome: result.outcome,
      delivered,
      reply: delivered === "sent" ? replyText : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
    if (ticketId)
      await store.updateTicket(tenantId, ticketId, { status: "needs_attention" }).catch(() => {});
    await store
      .audit(tenantId, {
        actorType: "system",
        action: "pipeline_failed",
        entityType: "ticket",
        entityId: ticketId ?? undefined,
        reason: maskPII(message),
      })
      .catch(() => {});
    await store
      .finishMessage(msg.channel, msg.providerMessageId, "failed", ticketId, maskPII(message))
      .catch(() => {});
    await reportFailure(store, deps.alert, `pipeline_${msg.channel}`, message);
    return { status: "failed", ticketId, error: message };
  }
}

function addInbound(deps: PipelineDeps, tenantId: string, ticketId: string, msg: InboundMessage) {
  return deps.store.addMessage(tenantId, ticketId, {
    direction: "inbound",
    author: "customer",
    status: "received",
    body: msg.text,
    providerMessageId: msg.providerMessageId,
    metadata: {
      auth: msg.auth,
      messageIdHeader: msg.headers["message-id"] ?? null,
      references: msg.headers["references"] ?? null,
    },
  });
}

async function recordUsage(deps: PipelineDeps, result: AgentResult) {
  // Per model call (not per distinct model) so free-tier quota tracking isn't under-counted.
  const providers = new Set(result.models.map((m) => m.split(":")[0]));
  await deps.store.addUsage("all", "requests", result.usage.modelCalls);
  for (const p of providers) await deps.store.addUsage(p, "tickets", 1);
  await deps.store.addUsage("all", "tokens_in", result.usage.inputTokens);
  await deps.store.addUsage("all", "tokens_out", result.usage.outputTokens);
}

async function deliver(
  deps: PipelineDeps,
  tenantId: string,
  ticketId: string,
  msg: InboundMessage,
  body: string,
  meta: { inReplyTo: string | null; references: string | null },
): Promise<Delivery> {
  // Chat replies are returned synchronously by the API route; they're recorded as sent here.
  if (msg.channel === "chat") {
    await deps.store.addMessage(tenantId, ticketId, {
      direction: "outbound",
      author: "ai",
      status: "sent",
      body,
      metadata: meta,
    });
    return "sent";
  }
  if (!deps.sender || !msg.from.email) {
    await deps.store.addMessage(tenantId, ticketId, {
      direction: "outbound",
      author: "ai",
      status: "failed",
      body,
      metadata: { ...meta, error: "no email sender configured" },
    });
    return "none";
  }
  try {
    const sent = await deps.sender.send({
      channel: msg.channel,
      threadKey: msg.threadKey,
      to: msg.from.email,
      subject: msg.subject,
      body,
      ...meta,
    });
    await deps.store.addMessage(tenantId, ticketId, {
      direction: "outbound",
      author: "ai",
      status: "sent",
      body,
      providerMessageId: sent.providerMessageId,
      metadata: meta,
    });
    await deps.store.addUsage("gmail", "emails_sent", 1);
    return "sent";
  } catch (error) {
    await deps.store.addMessage(tenantId, ticketId, {
      direction: "outbound",
      author: "ai",
      status: "failed",
      body,
      metadata: { ...meta, error: (error as Error).message.slice(0, 200) },
    });
    return "none";
  }
}

/** The account action awaiting a human: proposed (draft/shadow mode) or needing approval (over limit). */
function pendingActionOf(result: AgentResult) {
  return (
    result.actions.find((a) => a.status === "proposed" || a.status === "pending_approval") ?? null
  );
}

function investigation(result: AgentResult) {
  return {
    classification: result.classification,
    tools: result.trace
      .filter((t) => t.type === "tool_call" || t.type === "retrieval")
      .map((t) => ({ name: t.name, input: t.input, output: t.output })),
    actions: result.actions,
    citations: result.citations.map((c) => ({ slug: c.slug, title: c.title })),
    injection: result.injection,
  };
}

const now = (deps: PipelineDeps) => (deps.now?.() ?? new Date()).toISOString();

export type { TicketRef };
