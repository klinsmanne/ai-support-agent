import type { AgentRepo } from "../agent/domain.ts";
import { runAgent, type AgentResult } from "../agent/orchestrator.ts";
import { emailSkipReason, plusTag } from "../channels/email/filters.ts";
import type { ChannelSender, InboundMessage } from "../channels/types.ts";
import type { ModelRouter } from "../llm/router.ts";
import { maskPII } from "../guardrails/pii.ts";
import type { PipelineStore } from "./store.ts";

/**
 * The ticket pipeline, shared by every channel:
 * route tenant → dedupe → filter loops/noise → rate limits → verify sender → ticket (threaded)
 * → agent → persist run + trace → act per rollout mode → audit. Nothing is ever dropped silently:
 * failures end as `needs_attention` tickets.
 */

export interface PipelineDeps {
  store: PipelineStore;
  repo: AgentRepo;
  router: Pick<ModelRouter, "generate">;
  classifierRouter?: Pick<ModelRouter, "generate">;
  sender: ChannelSender | null;
  inboxAddress: string;
  defaultTenantSlug: string;
  /** Builds the public CSAT link for a ticket (optional). */
  csatUrl?: (ticketId: string) => string;
  now?: () => Date;
}

export type IngestResult =
  | { status: "duplicate" }
  | { status: "skipped"; reason: string; ticketId: string | null }
  | { status: "rate_limited"; ticketId: string }
  | {
      status: "processed";
      ticketId: string;
      outcome: AgentResult["outcome"];
      delivered: "sent" | "draft" | "pending_approval" | "none";
      reply: string | null;
    }
  | { status: "failed"; ticketId: string | null; error: string };

const LIMITS = {
  perSenderPerHour: 6,
  perThreadPerHour: 8,
  globalPerMinute: 30,
};

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

export async function ingestMessage(
  msg: InboundMessage,
  deps: PipelineDeps,
  opts: { tenantId?: string; chatVerifiedCustomerId?: string | null } = {},
): Promise<IngestResult> {
  const { store } = deps;
  const tenantId = opts.tenantId ?? (await resolveTenant(msg, deps));
  if (!tenantId) return { status: "failed", ticketId: null, error: "no tenant for message" };

  // 1. Idempotency: a provider message is processed at most once, even if polls overlap.
  if (!(await store.claimMessage(msg.channel, msg.providerMessageId, tenantId)))
    return { status: "duplicate" };

  let ticketId: string | null = null;
  try {
    const settings = await store.settings(tenantId);

    // 2. Loop prevention / noise (email): never reply to ourselves, auto-replies, lists, bounces.
    const skip =
      msg.channel === "email"
        ? emailSkipReason(msg, [deps.inboxAddress])
        : msg.text.trim()
          ? null
          : "empty_body";
    if (skip) {
      const t = await store.findOrCreateTicket(tenantId, msg.channel, msg.threadKey, {
        customerId: null,
        requesterEmail: msg.from.email,
        subject: msg.subject,
        senderVerified: false,
      });
      ticketId = t.id;
      await store.addMessage(tenantId, t.id, {
        direction: "inbound",
        author: "customer",
        status: "received",
        body: msg.text,
        providerMessageId: msg.providerMessageId,
      });
      if (t.created)
        await store.updateTicket(tenantId, t.id, {
          status: "closed",
          is_spam: true,
          intent: "auto_reply",
          closed_at: now(deps),
        });
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

    // 3. Sender verification: on file AND (email) authenticated by the receiving server.
    const customerId =
      msg.channel === "chat"
        ? (opts.chatVerifiedCustomerId ?? null)
        : msg.from.email
          ? await store.findCustomerIdByEmail(tenantId, msg.from.email)
          : null;
    const emailAuthenticated =
      msg.auth.dmarc === "pass" || (msg.auth.spf === "pass" && msg.auth.dkim === "pass");
    const senderVerified = !!customerId && (msg.channel === "chat" || emailAuthenticated);

    const ticket = await store.findOrCreateTicket(tenantId, msg.channel, msg.threadKey, {
      customerId: senderVerified ? customerId : null,
      requesterEmail: msg.from.email,
      subject: msg.subject,
      senderVerified,
    });
    ticketId = ticket.id;
    const inboundId = await store.addMessage(tenantId, ticket.id, {
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
    await store.updateTicket(tenantId, ticket.id, {
      status: "in_progress",
      ...(ticket.status === "awaiting_customer" || ticket.status === "resolved"
        ? { resolved_at: null }
        : {}),
    });

    // 4. Abuse protection: per-sender, per-thread and global rate limits plus the tenant's daily cap.
    const senderKey = msg.from.email ?? msg.threadKey;
    const allowed =
      (await store.rateLimit(`sender:${tenantId}:${senderKey}`, 3600, LIMITS.perSenderPerHour)) &&
      (await store.rateLimit(
        `thread:${tenantId}:${msg.threadKey}`,
        3600,
        LIMITS.perThreadPerHour,
      )) &&
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

    // 5. The agent.
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
      { router: deps.router, classifierRouter: deps.classifierRouter, repo: deps.repo },
    );
    const runId = await store.saveRun(tenantId, ticket.id, inboundId, result);
    for (const model of result.models) {
      const [provider] = model.split(":");
      await store.addUsage(provider, "requests", 1);
    }
    await store.addUsage("all", "tokens_in", result.usage.inputTokens);
    await store.addUsage("all", "tokens_out", result.usage.outputTokens);

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

    // 6. Act according to the outcome and the tenant's rollout mode.
    let delivered: "sent" | "draft" | "pending_approval" | "none" = "none";
    let replyText: string | null = null;
    const replyMeta = {
      inReplyTo: msg.headers["message-id"] ?? null,
      references: msg.headers["references"] ?? null,
    };

    if (result.outcome === "closed_no_reply") {
      await store.updateTicket(tenantId, ticket.id, {
        ...triage,
        status: "closed",
        is_spam: true,
        closed_at: now(deps),
      });
    } else if (result.outcome === "resolved" || result.outcome === "awaiting_customer") {
      replyText = result.reply!;
      if (settings.rollout_mode === "auto_send") {
        delivered = await deliver(deps, tenantId, ticket.id, msg, replyText, replyMeta);
        await store.updateTicket(tenantId, ticket.id, {
          ...triage,
          status: delivered === "sent" ? result.outcome : "needs_attention",
          ai_reply_count: ticket.aiReplyCount + 1,
          ...(result.outcome === "resolved" ? { resolved_at: now(deps) } : {}),
          ...(ticket.firstResponseAt
            ? {}
            : delivered === "sent"
              ? { first_response_at: now(deps) }
              : {}),
        });
      } else {
        // shadow: draft only for comparison; draft_only: a human approves before sending.
        delivered = settings.rollout_mode === "draft_only" ? "pending_approval" : "draft";
        await store.addMessage(tenantId, ticket.id, {
          direction: "outbound",
          author: "ai",
          status: delivered,
          body: replyText,
          metadata: replyMeta,
        });
        if (settings.rollout_mode === "draft_only") {
          await store.createEscalation(tenantId, ticket.id, {
            runId,
            reasonCodes: ["draft_review"],
            summary: c?.summary ?? "AI draft awaiting approval",
            investigation: investigation(result),
            suggestedReply: replyText,
          });
        }
        await store.updateTicket(tenantId, ticket.id, {
          ...triage,
          status: settings.rollout_mode === "draft_only" ? "escalated" : "in_progress",
        });
      }
    } else {
      // escalated / error: a human takes over with a summary and a suggested reply.
      await store.createEscalation(tenantId, ticket.id, {
        runId,
        reasonCodes: result.escalation?.reasons ?? ["agent_error"],
        summary: result.escalation?.summary ?? "Agent error",
        investigation: investigation(result),
        suggestedReply: result.escalation?.suggestedReply ?? null,
        pendingAction: result.actions.find((a) => a.status === "pending_approval") ?? null,
      });
      // A short holding reply keeps first-response time low while a human reviews (auto_send only).
      if (
        settings.rollout_mode === "auto_send" &&
        ticket.aiReplyCount < settings.max_ai_replies_per_thread &&
        !settings.kill_switch
      ) {
        const lang = c?.language ?? "en";
        delivered = await deliver(
          deps,
          tenantId,
          ticket.id,
          msg,
          HOLDING_REPLY[lang] ?? HOLDING_REPLY.en,
          replyMeta,
        );
        replyText = HOLDING_REPLY[lang] ?? HOLDING_REPLY.en;
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
      details: { runId, delivered, injection: result.injection },
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
    return { status: "failed", ticketId, error: message };
  }
}

async function deliver(
  deps: PipelineDeps,
  tenantId: string,
  ticketId: string,
  msg: InboundMessage,
  body: string,
  meta: { inReplyTo: string | null; references: string | null },
): Promise<"sent" | "none"> {
  // Chat replies are returned synchronously by the API route; they're recorded as sent here.
  if (msg.channel === "chat" || !deps.sender) {
    await deps.store.addMessage(tenantId, ticketId, {
      direction: "outbound",
      author: "ai",
      status: "sent",
      body,
      metadata: meta,
    });
    return "sent";
  }
  if (!msg.from.email) return "none";
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
