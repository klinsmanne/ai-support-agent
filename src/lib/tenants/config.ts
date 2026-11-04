import { z } from "zod";

/**
 * Tenant configuration — the single source of truth for onboarding a client.
 * A new client = a new `tenants/<slug>/tenant.json` + `kb/*.md`, validated by this schema.
 * No code changes are needed to add a tenant.
 */
export const TOOL_NAMES = [
  "get_customer",
  "get_orders",
  "get_ticket_history",
  "search_knowledge_base",
  "issue_refund",
  "update_order",
  "send_reply",
  "escalate_to_human",
] as const;
export const ToolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const RolloutModeSchema = z.enum(["shadow", "draft_only", "auto_send"]);
export type RolloutMode = z.infer<typeof RolloutModeSchema>;

const languageCode = z.string().regex(/^[a-z]{2}$/, "ISO 639-1 code, e.g. en");
const singleLine = z
  .string()
  .min(1)
  .regex(/^[^\r\n]+$/, "must be a single line");
const domain = z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "bare domain, e.g. example.com");

export const TenantSettingsSchema = z
  .object({
    rollout_mode: RolloutModeSchema.default("shadow"),
    refund_auto_approve_limit_cents: z.number().int().min(0).max(1_000_00),
    max_refunds_per_customer_30d: z.number().int().min(0).max(20),
    escalate_on_negative_sentiment_below: z.number().min(-1).max(0),
    min_confidence_to_act: z.number().min(0).max(1),
    enabled_tools: z
      .array(ToolNameSchema)
      .min(1)
      .refine((tools) => new Set(tools).size === tools.length, "duplicate tool"),
    brand_name: singleLine.max(80),
    brand_voice: z.string().min(10).max(600),
    supported_languages: z.array(languageCode).min(1),
    allowed_link_domains: z.array(domain),
    support_email: z.email().optional(),
    csat_enabled: z.boolean().default(true),
    daily_ticket_cap: z.number().int().min(1).max(10_000),
    max_ai_replies_per_thread: z.number().int().min(1).max(20),
    retention_days: z.number().int().min(7).max(3650),
  })
  .strict()
  .refine((s) => s.enabled_tools.includes("escalate_to_human"), {
    message: "escalate_to_human must always be enabled — the agent must always be able to hand off",
    path: ["enabled_tools"],
  });
export type TenantSettings = z.infer<typeof TenantSettingsSchema>;

const CustomerSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9-]+$/),
    email: z.email().transform((e) => e.toLowerCase()),
    name: singleLine,
    preferred_language: languageCode.default("en"),
    plan: z.string().optional(),
  })
  .strict();

const AddressSchema = z
  .object({
    line1: z.string(),
    city: z.string(),
    region: z.string().optional(),
    postal_code: z.string(),
    country: z.string().length(2),
  })
  .strict();

const OrderSchema = z
  .object({
    order_number: z.string().regex(/^[A-Z0-9-]{3,20}$/),
    customer: z.string(),
    status: z.enum([
      "pending",
      "processing",
      "shipped",
      "delayed",
      "delivered",
      "cancelled",
      "returned",
    ]),
    currency: z.string().length(3).default("USD"),
    total_cents: z.number().int().min(0),
    items: z
      .array(
        z
          .object({
            sku: z.string(),
            name: z.string(),
            qty: z.number().int().min(1),
            price_cents: z.number().int().min(0),
            final_sale: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1),
    carrier: z.string().optional(),
    tracking_number: z.string().optional(),
    placed_days_ago: z.number().int().min(0),
    shipped_days_ago: z.number().int().min(0).optional(),
    delivered_days_ago: z.number().int().min(0).optional(),
    estimated_delivery_in_days: z.number().int().optional(),
    /** Seeds a second captured payment to simulate a double charge. */
    duplicate_charge: z.boolean().optional(),
    shipping_address: AddressSchema.optional(),
  })
  .strict();

export const TenantConfigSchema = z
  .object({
    $schema: z.string().optional(),
    slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
    name: singleLine,
    industry: z.enum(["ecommerce", "saas", "other"]),
    /**
     * Fictional demo tenant: its orders and refunds are reset daily (reset_demo_data) so the
     * public demo keeps working. Never set this for a real client — the reset would erase their
     * refunds and restore orders to the config. Defaults to false.
     */
    demo: z.boolean().default(false),
    settings: TenantSettingsSchema,
    customers: z.array(CustomerSchema),
    orders: z.array(OrderSchema),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const dupes = (values: string[]) => values.filter((v, i) => values.indexOf(v) !== i);

    // Duplicates would map to the same stable UUID and silently overwrite each other.
    for (const d of dupes(cfg.customers.map((c) => c.key)))
      issue(["customers"], `duplicate customer key "${d}"`);
    for (const d of dupes(cfg.customers.map((c) => c.email)))
      issue(["customers"], `duplicate customer email "${d}"`);
    for (const d of dupes(cfg.orders.map((o) => o.order_number)))
      issue(["orders"], `duplicate order number "${d}"`);

    const keys = new Set(cfg.customers.map((c) => c.key));
    cfg.orders.forEach((o, i) => {
      if (!keys.has(o.customer))
        issue(["orders", i, "customer"], `unknown customer key "${o.customer}"`);
      const itemsTotal = o.items.reduce((sum, it) => sum + it.qty * it.price_cents, 0);
      if (itemsTotal !== o.total_cents) {
        issue(
          ["orders", i, "total_cents"],
          `total_cents ${o.total_cents} != sum of items ${itemsTotal}`,
        );
      }
      if (o.shipped_days_ago !== undefined && o.shipped_days_ago > o.placed_days_ago) {
        issue(["orders", i, "shipped_days_ago"], "an order can't ship before it was placed");
      }
      if (
        o.delivered_days_ago !== undefined &&
        o.delivered_days_ago > (o.shipped_days_ago ?? o.placed_days_ago)
      ) {
        issue(["orders", i, "delivered_days_ago"], "an order can't be delivered before it shipped");
      }
    });
  });
export type TenantConfig = z.infer<typeof TenantConfigSchema>;
