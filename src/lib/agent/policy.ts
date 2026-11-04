import type { TenantSettings } from "../tenants/config.ts";
import type { Order, RefundReason } from "./domain.ts";

/**
 * Business rules enforced in code. The model can only *request* an action; these pure
 * functions decide. They never trust model-supplied facts — inputs come from the database.
 */

export type PolicyDecision =
  | { decision: "allow"; reasons: string[] }
  | { decision: "needs_approval"; reasons: string[] }
  | { decision: "deny"; reasons: string[] };

export interface ActorContext {
  /** Sender identity verified (email auth + matches customer on file, or chat verification). */
  senderVerified: boolean;
  /** Prompt injection suspected on this ticket: write actions are never auto-executed. */
  injectionSuspected: boolean;
}

export function evaluateRefund(input: {
  settings: Pick<
    TenantSettings,
    "refund_auto_approve_limit_cents" | "max_refunds_per_customer_30d" | "enabled_tools"
  >;
  actor: ActorContext;
  order: Order;
  amountCents: number;
  reason: RefundReason;
  refundsLast30Days: number;
}): PolicyDecision {
  const { settings, actor, order, amountCents, reason, refundsLast30Days } = input;
  const reasons: string[] = [];

  if (!settings.enabled_tools.includes("issue_refund"))
    return deny("refunds are not enabled for this tenant");
  if (!actor.senderVerified) return deny("sender identity not verified");
  if (actor.injectionSuspected) return deny("suspected prompt injection on this ticket");
  if (!Number.isInteger(amountCents) || amountCents <= 0) return deny("invalid amount");

  const refundable = order.capturedCents - order.refundedCents;
  if (refundable <= 0) return deny("nothing left to refund on this order");
  if (amountCents > refundable)
    return deny(`amount exceeds refundable balance (${refundable} cents)`);

  if (reason === "duplicate_charge") {
    // Verify the claim against payment records rather than the customer's word.
    if (order.capturedPayments < 2) return deny("no duplicate charge found on this order");
    if (amountCents > order.totalCents) return deny("duplicate refund cannot exceed one charge");
  }
  if (reason === "lost_package" && !["shipped", "delayed"].includes(order.status)) {
    reasons.push(`order status is "${order.status}", not in transit`);
  }
  if (reason === "other" || reason === "not_as_described")
    reasons.push(`reason "${reason}" requires human judgment`);
  if (amountCents > settings.refund_auto_approve_limit_cents) {
    reasons.push(
      `amount ${amountCents} exceeds auto-approve limit ${settings.refund_auto_approve_limit_cents}`,
    );
  }
  if (refundsLast30Days >= settings.max_refunds_per_customer_30d) {
    reasons.push(`customer already had ${refundsLast30Days} refunds in 30 days`);
  }

  return reasons.length
    ? { decision: "needs_approval", reasons }
    : { decision: "allow", reasons: ["within policy"] };
}

/** Address changes are only possible before the order ships. */
export function evaluateAddressChange(input: {
  settings: Pick<TenantSettings, "enabled_tools">;
  actor: ActorContext;
  order: Order;
}): PolicyDecision {
  const { settings, actor, order } = input;
  if (!settings.enabled_tools.includes("update_order"))
    return deny("order changes are not enabled for this tenant");
  if (!actor.senderVerified) return deny("sender identity not verified");
  if (actor.injectionSuspected) return deny("suspected prompt injection on this ticket");
  if (!["pending", "processing"].includes(order.status)) {
    return deny(`order already ${order.status}; address can no longer be changed`);
  }
  return { decision: "allow", reasons: ["order not yet shipped"] };
}

export type EscalationReason =
  | "customer_requested_human"
  | "very_negative_sentiment"
  | "low_confidence"
  | "outside_policy"
  | "amount_above_threshold"
  | "suspected_prompt_injection"
  | "legal_or_safety"
  | "reply_validation_failed"
  | "agent_error"
  | "reply_cap_reached"
  | "kill_switch_active";

/** Escalation triggers that are decided in code from the classification, before any tool runs. */
export function preflightEscalation(input: {
  settings: Pick<TenantSettings, "escalate_on_negative_sentiment_below">;
  classification: { wants_human: boolean; sentiment: number; intent: string };
  aiReplyCount: number;
  maxAiReplies: number;
}): EscalationReason[] {
  const reasons: EscalationReason[] = [];
  const { settings, classification } = input;
  if (classification.wants_human) reasons.push("customer_requested_human");
  if (classification.sentiment < settings.escalate_on_negative_sentiment_below)
    reasons.push("very_negative_sentiment");
  if (classification.intent === "legal_or_safety") reasons.push("legal_or_safety");
  if (input.aiReplyCount >= input.maxAiReplies) reasons.push("reply_cap_reached");
  return reasons;
}

const deny = (reason: string): PolicyDecision => ({ decision: "deny", reasons: [reason] });
