import { createHash } from "node:crypto";
import { z } from "zod";
import type { TenantSettings, ToolName } from "../tenants/config.ts";
import type { ToolSpec } from "../llm/types.ts";
import type { AgentRepo, KbHit, Order } from "./domain.ts";
import { evaluateAddressChange, evaluateRefund, type EscalationReason } from "./policy.ts";

/**
 * Least-privilege tools. Design rules:
 * - Narrow, schema-validated inputs (order numbers, enums) — never free-form queries, IDs or URLs.
 * - The customer is taken from the verified ticket context, never from model arguments, so the
 *   model cannot read or change another customer's data.
 * - Write tools call the policy engine; in shadow/draft modes they only *propose* actions.
 */

export interface ToolContext {
  tenantId: string;
  ticketId: string;
  /** Set only when the sender is verified as this customer. */
  customerId: string | null;
  senderVerified: boolean;
  injectionSuspected: boolean;
  settings: TenantSettings;
  /** auto_send executes approved actions; shadow/draft_only record them as proposals. */
  executeActions: boolean;
  repo: AgentRepo;
}

export type ActionRecord =
  | {
      type: "refund";
      orderNumber: string;
      amountCents: number;
      reason: string;
      status: "executed" | "proposed" | "pending_approval" | "denied";
      policy: string[];
    }
  | {
      type: "address_change";
      orderNumber: string;
      status: "executed" | "proposed" | "denied";
      policy: string[];
    };

export interface ToolOutcome {
  /** JSON-serializable result shown to the model. */
  output: unknown;
  isError?: boolean;
  action?: ActionRecord;
  citations?: KbHit[];
  /** Terminal tools end the agent loop. */
  terminal?:
    | { kind: "reply"; message: string; citedSlugs: string[]; expectsCustomerReply: boolean }
    | { kind: "escalate"; reason: EscalationReason; summary: string; suggestedReply: string };
  /** A write action that requires a human — forces escalation after the loop. */
  needsHuman?: EscalationReason;
}

const OrderNumber = z
  .string()
  .trim()
  .transform((s) => s.replace(/^#/, "").toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9-]{3,20}$/, "order numbers look like 1042 or INV-2041"));

const schemas = {
  get_customer: z.object({}).strict(),
  get_orders: z.object({ order_number: OrderNumber.optional() }).strict(),
  get_ticket_history: z.object({}).strict(),
  search_knowledge_base: z.object({ query: z.string().trim().min(2).max(300) }).strict(),
  issue_refund: z
    .object({
      order_number: OrderNumber,
      amount_cents: z.number().int().positive().max(10_000_000),
      reason: z.enum([
        "duplicate_charge",
        "damaged_item",
        "lost_package",
        "not_as_described",
        "other",
      ]),
    })
    .strict(),
  update_order: z
    .object({
      order_number: OrderNumber,
      new_shipping_address: z
        .object({
          line1: z.string().trim().min(3).max(120),
          city: z.string().trim().min(1).max(80),
          region: z.string().trim().max(80).optional(),
          postal_code: z.string().trim().min(2).max(20),
          country: z.string().trim().length(2).toUpperCase(),
        })
        .strict(),
    })
    .strict(),
  send_reply: z
    .object({
      message: z.string().trim().min(1).max(4000),
      cited_kb_slugs: z
        .array(z.string().regex(/^[a-z0-9-]+$/))
        .max(5)
        .default([]),
      /** true when the reply asks the customer something (ticket → awaiting_customer, not resolved). */
      expects_customer_reply: z.boolean().default(false),
    })
    .strict(),
  escalate_to_human: z
    .object({
      reason: z.enum([
        "customer_requested_human",
        "very_negative_sentiment",
        "low_confidence",
        "outside_policy",
        "amount_above_threshold",
        "legal_or_safety",
      ]),
      summary: z.string().trim().min(10).max(1500),
      suggested_reply: z.string().trim().min(1).max(4000),
    })
    .strict(),
} satisfies Record<ToolName, z.ZodType>;

const descriptions: Record<ToolName, string> = {
  get_customer:
    "Get the profile of the customer who sent this ticket (only available when the sender is verified).",
  get_orders:
    "List the verified customer's orders, or look up one of their orders by order number. Returns status, tracking, items and payment summary.",
  get_ticket_history: "List the verified customer's previous support tickets (most recent first).",
  search_knowledge_base:
    "Search the company help center for policies and how-tos. Always use this before answering policy questions, and cite the returned slugs.",
  issue_refund:
    "Request a refund on one of the verified customer's orders. Company policy code decides: it may execute, require human approval, or deny.",
  update_order:
    "Request a shipping address change on one of the verified customer's orders (only possible before it ships).",
  send_reply:
    "Send the final reply to the customer and end your turn. Include cited_kb_slugs for any policy you referenced.",
  escalate_to_human:
    "Hand the ticket to a human agent with a summary of what you found and a suggested reply. Use when unsure, outside policy, or when the customer asks for a person.",
};

export function toolSpecs(enabled: readonly ToolName[]): ToolSpec[] {
  return enabled.map((name) => ({
    name,
    description: descriptions[name],
    parameters: z.toJSONSchema(schemas[name], { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >,
  }));
}

/** Validates arguments and runs a tool. Never throws for model mistakes — returns an error result. */
export async function executeTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (!(name in schemas) || !ctx.settings.enabled_tools.includes(name as ToolName)) {
    return { output: { error: `tool "${name}" is not available` }, isError: true };
  }
  const parsed = schemas[name as ToolName].safeParse(rawArgs);
  if (!parsed.success) {
    return {
      output: { error: "invalid arguments", details: z.prettifyError(parsed.error) },
      isError: true,
    };
  }
  const args = parsed.data as never;
  switch (name as ToolName) {
    case "get_customer":
      return getCustomer(ctx);
    case "get_orders":
      return getOrders(ctx, args);
    case "get_ticket_history":
      return getTicketHistory(ctx);
    case "search_knowledge_base":
      return searchKnowledgeBase(ctx, args);
    case "issue_refund":
      return issueRefund(ctx, args);
    case "update_order":
      return updateOrder(ctx, args);
    case "send_reply": {
      const a = args as z.infer<(typeof schemas)["send_reply"]>;
      return {
        output: { ok: true },
        terminal: {
          kind: "reply",
          message: a.message,
          citedSlugs: a.cited_kb_slugs,
          expectsCustomerReply: a.expects_customer_reply,
        },
      };
    }
    case "escalate_to_human": {
      const a = args as z.infer<(typeof schemas)["escalate_to_human"]>;
      return {
        output: { ok: true },
        terminal: {
          kind: "escalate",
          reason: a.reason,
          summary: a.summary,
          suggestedReply: a.suggested_reply,
        },
      };
    }
  }
}

const UNVERIFIED = {
  error: "sender_not_verified",
  message:
    "Account data is only available to verified customers. Answer general questions, and explain how to verify (chat: order number + email on file).",
};

async function getCustomer(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.customerId) return { output: UNVERIFIED, isError: true };
  const c = await ctx.repo.getCustomer(ctx.tenantId, ctx.customerId);
  if (!c) return { output: { error: "customer not found" }, isError: true };
  return {
    output: {
      name: c.name,
      email: c.email,
      preferred_language: c.preferredLanguage,
      plan: c.plan ?? undefined,
    },
  };
}

/** Customer-facing view of an order: no internal IDs. */
function publicOrder(o: Order) {
  return {
    order_number: o.orderNumber,
    status: o.status,
    total: `${(o.totalCents / 100).toFixed(2)} ${o.currency}`,
    items: o.items.map((i) => ({ name: i.name, qty: i.qty, final_sale: i.final_sale ?? false })),
    carrier: o.carrier ?? undefined,
    tracking_number: o.trackingNumber ?? undefined,
    estimated_delivery: o.estimatedDelivery ?? undefined,
    placed_at: o.placedAt,
    shipped_at: o.shippedAt ?? undefined,
    delivered_at: o.deliveredAt ?? undefined,
    shipping_address: o.shippingAddress,
    payments: {
      captured_charges: o.capturedPayments,
      captured_total_cents: o.capturedCents,
      refunded_cents: o.refundedCents,
    },
  };
}

async function findOwnOrder(ctx: ToolContext, orderNumber: string): Promise<Order | null> {
  if (!ctx.customerId) return null;
  const orders = await ctx.repo.listOrders(ctx.tenantId, ctx.customerId);
  return orders.find((o) => o.orderNumber === orderNumber) ?? null;
}

async function getOrders(ctx: ToolContext, args: { order_number?: string }): Promise<ToolOutcome> {
  if (!ctx.customerId) return { output: UNVERIFIED, isError: true };
  if (args.order_number) {
    const o = await findOwnOrder(ctx, args.order_number);
    // Same response whether the order doesn't exist or belongs to someone else: no enumeration.
    if (!o)
      return {
        output: { error: `no order ${args.order_number} found on this customer's account` },
        isError: true,
      };
    return { output: { orders: [publicOrder(o)] } };
  }
  const orders = await ctx.repo.listOrders(ctx.tenantId, ctx.customerId);
  return { output: { orders: orders.slice(0, 10).map(publicOrder) } };
}

async function getTicketHistory(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.customerId) return { output: UNVERIFIED, isError: true };
  const tickets = await ctx.repo.listTicketHistory(ctx.tenantId, ctx.customerId, ctx.ticketId, 5);
  return {
    output: {
      tickets: tickets.map((t) => ({
        subject: t.subject,
        status: t.status,
        intent: t.intent,
        created_at: t.createdAt,
      })),
    },
  };
}

async function searchKnowledgeBase(
  ctx: ToolContext,
  args: { query: string },
): Promise<ToolOutcome> {
  const hits = await ctx.repo.searchKb(ctx.tenantId, args.query, 4);
  return {
    output: { results: hits.map((h) => ({ slug: h.slug, title: h.title, content: h.content })) },
    citations: hits,
  };
}

async function issueRefund(
  ctx: ToolContext,
  args: {
    order_number: string;
    amount_cents: number;
    reason: z.infer<(typeof schemas)["issue_refund"]>["reason"];
  },
): Promise<ToolOutcome> {
  const order = await findOwnOrder(ctx, args.order_number);
  if (!order)
    return {
      output: { error: `no order ${args.order_number} found on this customer's account` },
      isError: true,
    };

  const policy = evaluateRefund({
    settings: ctx.settings,
    actor: { senderVerified: ctx.senderVerified, injectionSuspected: ctx.injectionSuspected },
    order,
    amountCents: args.amount_cents,
    reason: args.reason,
    refundsLast30Days: await ctx.repo.countRefundsLast30Days(ctx.tenantId, order.customerId),
  });
  const base = {
    type: "refund" as const,
    orderNumber: order.orderNumber,
    amountCents: args.amount_cents,
    reason: args.reason,
    policy: policy.reasons,
  };

  if (policy.decision === "deny") {
    return {
      output: { status: "denied", reasons: policy.reasons },
      action: { ...base, status: "denied" },
    };
  }
  if (policy.decision === "needs_approval") {
    return {
      output: {
        status: "pending_human_approval",
        reasons: policy.reasons,
        note: "Tell the customer a team member will review this shortly.",
      },
      action: { ...base, status: "pending_approval" },
      needsHuman: "amount_above_threshold",
    };
  }
  if (!ctx.executeActions) {
    return {
      output: {
        status: "proposed",
        note: "Refund is within policy and queued for team review (draft mode).",
      },
      action: { ...base, status: "proposed" },
    };
  }
  // Idempotency: the same ticket can't refund the same order/amount/reason twice.
  const idempotencyKey = createHash("sha256")
    .update([ctx.ticketId, order.id, args.amount_cents, args.reason].join("|"))
    .digest("hex")
    .slice(0, 32);
  const created = await ctx.repo.createRefund(ctx.tenantId, {
    orderId: order.id,
    customerId: order.customerId,
    ticketId: ctx.ticketId,
    amountCents: args.amount_cents,
    reason: args.reason,
    status: "approved",
    idempotencyKey,
  });
  return {
    output: {
      status: created.duplicate ? "already_refunded" : "refunded",
      amount: `${(args.amount_cents / 100).toFixed(2)} ${order.currency}`,
      timeline: "Refunds appear within 5–10 business days.",
    },
    action: { ...base, status: "executed" },
  };
}

async function updateOrder(
  ctx: ToolContext,
  args: z.infer<(typeof schemas)["update_order"]>,
): Promise<ToolOutcome> {
  const order = await findOwnOrder(ctx, args.order_number);
  if (!order)
    return {
      output: { error: `no order ${args.order_number} found on this customer's account` },
      isError: true,
    };

  const policy = evaluateAddressChange({
    settings: ctx.settings,
    actor: { senderVerified: ctx.senderVerified, injectionSuspected: ctx.injectionSuspected },
    order,
  });
  const base = {
    type: "address_change" as const,
    orderNumber: order.orderNumber,
    policy: policy.reasons,
  };
  if (policy.decision !== "allow") {
    return {
      output: { status: "denied", reasons: policy.reasons },
      action: { ...base, status: "denied" },
    };
  }
  if (!ctx.executeActions) {
    return {
      output: { status: "proposed", note: "Address change queued for team review (draft mode)." },
      action: { ...base, status: "proposed" },
    };
  }
  await ctx.repo.updateShippingAddress(ctx.tenantId, order.id, args.new_shipping_address);
  return {
    output: { status: "updated", shipping_address: args.new_shipping_address },
    action: { ...base, status: "executed" },
  };
}
