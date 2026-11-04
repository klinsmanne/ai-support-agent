"use server";

import { createHash } from "node:crypto";
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

  const edited = parsed.data.reply && parsed.data.reply !== esc.suggested_reply;
  const body = (parsed.data.reply || esc.suggested_reply || "").trim();
  if (!body) return { ok: false, message: "Write a reply before sending." };
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

  // Claim the escalation first (conditional on still pending): two people clicking "Approve" at
  // once can't both send. Released again below if anything fails before the reply goes out.
  const claimedAt = new Date().toISOString();
  const { data: claimed } = await db
    .from("escalations")
    .update({
      status: edited ? "edited" : "approved",
      resolved_by: viewer!.userId,
      resolved_at: claimedAt,
    })
    .eq("tenant_id", tenantId)
    .eq("id", escalationId)
    .eq("status", "pending")
    .select("id");
  if (!claimed?.length) return { ok: false, message: "Someone else just handled this escalation." };
  const release = async (message: string): Promise<ActionResult> => {
    await db
      .from("escalations")
      .update({ status: "pending", resolved_by: null, resolved_at: null })
      .eq("tenant_id", tenantId)
      .eq("id", escalationId);
    return { ok: false, message };
  };

  // A pending refund approved by a human executes now, still through the atomic balance check.
  const pending = esc.pending_action as {
    type?: string;
    orderNumber?: string;
    amountCents?: number;
    reason?: string;
  } | null;
  if (
    pending?.type === "refund" &&
    pending.orderNumber &&
    pending.amountCents &&
    ticket.customer_id
  ) {
    const { data: order } = await db
      .from("orders")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("order_number", pending.orderNumber)
      .eq("customer_id", ticket.customer_id)
      .maybeSingle();
    if (!order) return release("Order for the pending refund not found.");
    const key = createHash("sha256")
      .update([order.id, pending.reason].join("|"))
      .digest("hex")
      .slice(0, 32);
    const { data: res, error } = await db.rpc("create_refund_checked", {
      p_tenant_id: tenantId,
      p_order_id: order.id,
      p_customer_id: ticket.customer_id,
      p_ticket_id: ticket.id,
      p_amount_cents: pending.amountCents,
      p_reason: pending.reason ?? "other",
      p_status: "approved",
      p_idempotency_key: key,
      p_max_refunds_30d: 100, // a human approval overrides the frequency guard, not the balance check
    });
    const row = (res as { refund_id: string | null; outcome: string }[] | null)?.[0];
    if (error || !row || (row.outcome !== "created" && row.outcome !== "duplicate")) {
      return release(`Refund not executed: ${error?.message ?? row?.outcome}`);
    }
    if (row.refund_id)
      await db
        .from("refunds")
        .update({ decided_by: "human", decided_by_user: viewer!.userId })
        .eq("tenant_id", tenantId)
        .eq("id", row.refund_id);
    await audit(
      tenantId,
      viewer!.userId,
      "refund:approved_by_human",
      "order",
      pending.orderNumber,
      `approved ${pending.amountCents} cents`,
    );
  }

  const signed = `${body}\n\n— ${settings.brand_name} support team`;
  const sendResult = await sendHumanReply(ticket, signed);
  if (!sendResult.ok) return release(sendResult.message);

  const now = new Date().toISOString();
  await db.from("messages").insert({
    tenant_id: tenantId,
    ticket_id: ticket.id,
    direction: "outbound",
    author: "human",
    status: "sent",
    body: signed,
    sent_at: now,
    provider_message_id: sendResult.providerMessageId ?? null,
  });
  await db
    .from("messages")
    .update({ status: "rejected" })
    .eq("tenant_id", tenantId)
    .eq("ticket_id", ticket.id)
    .eq("status", "pending_approval");
  await db
    .from("tickets")
    .update({
      status: "resolved",
      resolved_at: now,
      ...(ticket.first_response_at ? {} : { first_response_at: now }),
    })
    .eq("tenant_id", tenantId)
    .eq("id", ticket.id);
  await audit(
    tenantId,
    viewer!.userId,
    edited ? "escalation:edited_and_sent" : "escalation:approved_and_sent",
    "ticket",
    ticket.id,
    esc.reason_codes.join(", "),
  );
  revalidatePath(`/dashboard/tickets/${ticket.id}`);
  return {
    ok: true,
    message:
      ticket.channel === "email" ? "Reply sent by email." : "Reply saved to the chat conversation.",
  };
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
  revalidatePath(`/dashboard/tickets/${esc.ticket_id}`);
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
});

export async function updateSettings(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const raw = Object.fromEntries(form);
  const parsed = SettingsInput.safeParse({ kill_switch: "false", ...raw });
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
