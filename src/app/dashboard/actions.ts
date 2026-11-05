"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer, requireRole } from "@/lib/auth/server";
import { validateReply } from "@/lib/guardrails/output";
import { maskDeep } from "@/lib/guardrails/pii";
import { getContainer } from "@/lib/server/container";

/**
 * Dashboard write actions. Pattern for every action:
 * 1) authenticate (getViewer) and authorize (requireRole) on the target tenant — the demo viewer
 *    and other viewers are refused here even if they call the action directly;
 * 2) validate input with Zod; 3) write with the service client, always scoped by tenant_id;
 * 4) record who did what and why in the audit log.
 */

export type ActionResult = { ok: boolean; message: string };

const EscalationInput = z.object({
  tenantId: z.uuid(),
  escalationId: z.uuid(),
  reply: z.string().trim().max(4000).optional(),
});

export async function approveEscalation(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = EscalationInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  const { tenantId, escalationId } = parsed.data;
  const viewer = await getViewer();
  try {
    requireRole(viewer, tenantId, ["owner", "agent"]);
  } catch {
    return { ok: false, message: "Your role can't approve replies (read-only)." };
  }
  const userId = viewer!.userId;
  const c = getContainer();
  const db = c.db;

  const { data: esc } = await db
    .from("escalations")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", escalationId)
    .maybeSingle();
  if (!esc || esc.status !== "pending")
    return { ok: false, message: "This escalation was already handled." };
  const { data: ticket } = await db
    .from("tickets")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", esc.ticket_id)
    .single();
  const { data: settings } = await db
    .from("tenant_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .single();
  if (!ticket || !settings) return { ok: false, message: "Ticket not found." };

  // An explicitly cleared textarea means "no reply", never "fall back to the AI suggestion".
  const body = (parsed.data.reply ?? esc.suggested_reply ?? "").trim();
  if (!body) return { ok: false, message: "Write a reply before sending." };
  const edited = body !== (esc.suggested_reply ?? "").trim();
  // Human replies go through the same output checks as AI replies (no foreign emails, unapproved links…).
  const verdict = validateReply(body, {
    canary: "",
    customerEmail: ticket.requester_email,
    supportEmail: c.deps.inboxAddress,
    allowedLinkDomains: settings.allowed_link_domains,
    internalIds: [tenantId, ticket.id],
  });
  if (!verdict.ok)
    return {
      ok: false,
      message: `Reply blocked by safety checks: ${verdict.violations.join(", ")}`,
    };

  // 1. Claim (conditional on still pending): two people clicking "Approve" at once can't both act.
  const claimedAt = new Date().toISOString();
  const { data: claimed } = await db
    .from("escalations")
    .update({ status: edited ? "edited" : "approved", resolved_by: userId, resolved_at: claimedAt })
    .eq("tenant_id", tenantId)
    .eq("id", escalationId)
    .eq("status", "pending")
    .select("id");
  if (!claimed?.length) return { ok: false, message: "Someone else just handled this escalation." };
  // Release only our own claim, and only while nothing irreversible has happened yet.
  const release = async (message: string): Promise<ActionResult> => {
    await db
      .from("escalations")
      .update({ status: "pending", resolved_by: null, resolved_at: null })
      .eq("tenant_id", tenantId)
      .eq("id", escalationId)
      .eq("resolved_by", userId)
      .eq("resolved_at", claimedAt);
    return { ok: false, message };
  };

  // 2. Execute the action the reply talks about (a refund or address change awaiting approval),
  //    BEFORE sending — so the customer is never told about something that didn't happen.
  const action = await executePendingAction(
    tenantId,
    escalationId,
    esc.pending_action,
    ticket,
    userId,
  );
  if (!action.ok) return release(action.message);

  // 3. Send. If it fails after an action executed, don't pretend nothing happened: the action
  //    stays done, the ticket goes to needs_attention and the message says so.
  const signed = `${body}\n\n— ${settings.brand_name} support team`;
  const sendResult = await sendHumanReply(ticket, signed);
  if (!sendResult.ok) {
    if (!action.executed) return release(sendResult.message);
    await db
      .from("tickets")
      .update({ status: "needs_attention" })
      .eq("tenant_id", tenantId)
      .eq("id", ticket.id);
    await audit(
      tenantId,
      userId,
      "escalation:action_done_reply_failed",
      "ticket",
      ticket.id,
      sendResult.message,
    );
    revalidateDashboard(ticket.id);
    return {
      ok: false,
      message: `${action.executed} was executed, but the reply wasn't sent (${sendResult.message}). The ticket is marked "needs attention" — reply manually.`,
    };
  }

  // 4. Record. The email is already out, so failures here are reported, not hidden.
  const now = new Date().toISOString();
  const problems: string[] = [];
  const check = (what: string, r: { error: { message: string } | null }) => {
    if (r.error) problems.push(`${what}: ${r.error.message}`);
  };
  check(
    "save reply",
    await db.from("messages").insert({
      tenant_id: tenantId,
      ticket_id: ticket.id,
      direction: "outbound",
      author: "human",
      status: "sent",
      body: signed,
      sent_at: now,
      provider_message_id: sendResult.providerMessageId ?? null,
    }),
  );
  check(
    "retire AI draft",
    await db
      .from("messages")
      .update({ status: "rejected" })
      .eq("tenant_id", tenantId)
      .eq("ticket_id", ticket.id)
      .eq("status", "pending_approval"),
  );
  check(
    "resolve ticket",
    await db
      .from("tickets")
      .update({
        status: "resolved",
        resolved_at: now,
        ...(ticket.first_response_at ? {} : { first_response_at: now }),
      })
      .eq("tenant_id", tenantId)
      .eq("id", ticket.id),
  );
  if (ticket.channel === "email") await c.store.addUsage("gmail", "emails_sent", 1);
  await audit(
    tenantId,
    userId,
    edited ? "escalation:edited_and_sent" : "escalation:approved_and_sent",
    "ticket",
    ticket.id,
    [esc.reason_codes.join(", "), action.executed].filter(Boolean).join(" · "),
  );
  revalidateDashboard(ticket.id);
  const sentMsg =
    ticket.channel === "email" ? "Reply sent by email." : "Reply saved to the chat conversation.";
  if (problems.length)
    return { ok: true, message: `${sentMsg} Some records didn't save (${problems.join("; ")}).` };
  return {
    ok: true,
    message: action.executed ? `${action.executed} executed. ${sentMsg}` : sentMsg,
  };
}

type PendingAction = {
  type?: string;
  orderNumber?: string;
  amountCents?: number;
  reason?: string;
  address?: Record<string, string>;
} | null;

/**
 * Runs the account action an escalation proposed, after human approval. Refunds still go through
 * the atomic create_refund_checked (row lock + balance check); the idempotency key is this
 * escalation, so a retry can't double-refund and a *different* later refund isn't mistaken for a
 * duplicate. Address changes re-check "not shipped yet" inside the write.
 */
async function executePendingAction(
  tenantId: string,
  escalationId: string,
  pending: PendingAction,
  ticket: { id: string; customer_id: string | null },
  userId: string,
): Promise<{ ok: true; executed: string | null } | { ok: false; message: string }> {
  if (!pending?.type || !pending.orderNumber) return { ok: true, executed: null };
  if (!ticket.customer_id) {
    return {
      ok: false,
      message: "This ticket has no verified customer, so the account action can't run.",
    };
  }
  const db = getContainer().db;
  const { data: order } = await db
    .from("orders")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("order_number", pending.orderNumber)
    .eq("customer_id", ticket.customer_id)
    .maybeSingle();
  if (!order)
    return {
      ok: false,
      message: `Order ${pending.orderNumber} not found on this customer's account.`,
    };

  if (pending.type === "refund" && pending.amountCents) {
    const { data: res, error } = await db.rpc("create_refund_checked", {
      p_tenant_id: tenantId,
      p_order_id: order.id,
      p_customer_id: ticket.customer_id,
      p_ticket_id: ticket.id,
      p_amount_cents: pending.amountCents,
      p_reason: pending.reason ?? "other",
      p_status: "approved",
      p_idempotency_key: `escalation:${escalationId}`,
      p_max_refunds_30d: 100, // a human approval overrides the frequency guard, not the balance check
    });
    const row = (res as { refund_id: string | null; outcome: string }[] | null)?.[0];
    if (error || !row || (row.outcome !== "created" && row.outcome !== "duplicate")) {
      return {
        ok: false,
        message: `Refund not executed: ${error?.message ?? row?.outcome}. Nothing was sent.`,
      };
    }
    if (row.refund_id) {
      await db
        .from("refunds")
        .update({ decided_by: "human", decided_by_user: userId })
        .eq("tenant_id", tenantId)
        .eq("id", row.refund_id);
    }
    const label = `Refund of $${(pending.amountCents / 100).toFixed(2)} on order ${pending.orderNumber}`;
    await audit(
      tenantId,
      userId,
      `refund:approved_by_human${row.outcome === "duplicate" ? ":already_done" : ""}`,
      "order",
      pending.orderNumber,
      label,
    );
    return { ok: true, executed: label };
  }

  if (pending.type === "address_change" && pending.address) {
    const { data: updated, error } = await db
      .from("orders")
      .update({ shipping_address: pending.address })
      .eq("tenant_id", tenantId)
      .eq("id", order.id)
      .in("status", ["pending", "processing"])
      .select("id");
    if (error || !updated?.length) {
      return {
        ok: false,
        message: "Address not changed (the order may have shipped). Nothing was sent.",
      };
    }
    const label = `Address change on order ${pending.orderNumber}`;
    await audit(
      tenantId,
      userId,
      "address_change:approved_by_human",
      "order",
      pending.orderNumber,
      label,
    );
    return { ok: true, executed: label };
  }
  return { ok: true, executed: null };
}

function revalidateDashboard(ticketId: string) {
  revalidatePath(`/dashboard/tickets/${ticketId}`);
  revalidatePath("/dashboard/escalations");
  revalidatePath("/dashboard");
}

export async function rejectEscalation(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = EscalationInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  const { tenantId, escalationId } = parsed.data;
  const viewer = await getViewer();
  try {
    requireRole(viewer, tenantId, ["owner", "agent"]);
  } catch {
    return { ok: false, message: "Your role can't change escalations (read-only)." };
  }
  const db = getContainer().db;
  const { data: esc } = await db
    .from("escalations")
    .update({
      status: "rejected",
      resolved_by: viewer!.userId,
      resolved_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId)
    .eq("id", escalationId)
    .eq("status", "pending")
    .select("ticket_id")
    .maybeSingle();
  if (!esc) return { ok: false, message: "This escalation was already handled." };
  await db
    .from("messages")
    .update({ status: "rejected" })
    .eq("tenant_id", tenantId)
    .eq("ticket_id", esc.ticket_id)
    .eq("status", "pending_approval");
  await audit(
    tenantId,
    viewer!.userId,
    "escalation:rejected",
    "ticket",
    esc.ticket_id,
    "suggested reply rejected; handle manually",
  );
  revalidateDashboard(esc.ticket_id);
  return { ok: true, message: "Suggested reply rejected. The ticket stays with your team." };
}

const SettingsInput = z.object({
  tenantId: z.uuid(),
  rollout_mode: z.enum(["shadow", "draft_only", "auto_send"]),
  kill_switch: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
  refund_auto_approve_limit_cents: z.coerce.number().int().min(0).max(100_000),
  max_refunds_per_customer_30d: z.coerce.number().int().min(0).max(20),
  escalate_on_negative_sentiment_below: z.coerce.number().min(-1).max(0),
  min_confidence_to_act: z.coerce.number().min(0).max(1),
  daily_ticket_cap: z.coerce.number().int().min(1).max(10_000),
  max_ai_replies_per_thread: z.coerce.number().int().min(1).max(20),
  // Empty input turns notifications off (stored as null).
  escalation_notify_email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.email().max(254).nullable(),
  ),
  escalation_digest: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
});

export async function updateSettings(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const raw = Object.fromEntries(form);
  // Unticked checkboxes aren't submitted at all: default them to off.
  const parsed = SettingsInput.safeParse({
    kill_switch: "false",
    escalation_digest: "false",
    ...raw,
  });
  if (!parsed.success)
    return {
      ok: false,
      message: `Invalid settings: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    };
  const { tenantId, ...patch } = parsed.data;
  const viewer = await getViewer();
  try {
    requireRole(viewer, tenantId, ["owner"]);
  } catch {
    return { ok: false, message: "Only owners can change settings." };
  }
  const db = getContainer().db;
  const { data: before } = await db
    .from("tenant_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .single();
  const { error } = await db.from("tenant_settings").update(patch).eq("tenant_id", tenantId);
  if (error) return { ok: false, message: `Not saved: ${error.message}` };
  const changed = Object.fromEntries(
    Object.entries(patch).filter(([k, v]) => String(before?.[k]) !== String(v)),
  );
  await audit(
    tenantId,
    viewer!.userId,
    patch.kill_switch !== before?.kill_switch
      ? `kill_switch:${patch.kill_switch ? "on" : "off"}`
      : "settings:updated",
    "tenant_settings",
    tenantId,
    JSON.stringify(changed).slice(0, 500),
  );
  revalidatePath("/dashboard/settings");
  return {
    ok: true,
    message: Object.keys(changed).length
      ? `Saved: ${Object.keys(changed).join(", ")}`
      : "No changes.",
  };
}

async function sendHumanReply(
  ticket: {
    channel: string;
    external_thread_id: string | null;
    requester_email: string | null;
    subject: string | null;
    id: string;
    tenant_id: string;
  },
  body: string,
): Promise<{ ok: true; providerMessageId?: string } | { ok: false; message: string }> {
  if (ticket.channel !== "email") return { ok: true }; // chat: stored on the conversation
  const c = getContainer();
  if (!c.gmail || !ticket.requester_email || !ticket.external_thread_id)
    return { ok: false, message: "Email sending isn't configured for this ticket." };
  const { data: last } = await c.db
    .from("messages")
    .select("metadata")
    .eq("tenant_id", ticket.tenant_id)
    .eq("ticket_id", ticket.id)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const meta = (last?.metadata ?? {}) as {
    messageIdHeader?: string | null;
    references?: string | null;
  };
  try {
    const sent = await c.gmail.send({
      channel: "email",
      threadKey: ticket.external_thread_id.split("|")[0], // ticket key = Gmail thread + sender
      to: ticket.requester_email,
      subject: ticket.subject,
      body,
      inReplyTo: meta.messageIdHeader ?? null,
      references: meta.references ?? null,
    });
    return { ok: true, providerMessageId: sent.providerMessageId };
  } catch (error) {
    return { ok: false, message: `Email not sent: ${(error as Error).message.slice(0, 120)}` };
  }
}

async function audit(
  tenantId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  reason: string,
) {
  await getContainer()
    .db.from("audit_log")
    .insert({
      tenant_id: tenantId,
      actor_type: "human",
      actor_id: userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      reason,
      details: maskDeep({}),
    });
}
