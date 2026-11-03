import { chunkMarkdown } from "../rag/chunk.ts";
import type { TenantConfig, TenantSettings } from "../tenants/config.ts";
import { stableUuid } from "../tenants/seed-sql.ts";
import type {
  Address,
  AgentRepo,
  Customer,
  KbHit,
  Order,
  RefundOutcome,
  RefundRecord,
  TicketSummary,
} from "./domain.ts";

/**
 * In-memory AgentRepo built from tenant config files. Used by unit tests and the eval suite so
 * the full agent runs deterministically without a database. IDs match the seed (stableUuid).
 * Retrieval is keyword-based (BM25-style); vector retrieval is exercised against Supabase.
 */
export class MemoryRepo implements AgentRepo {
  private settings = new Map<string, TenantSettings & { kill_switch: boolean }>();
  private customers = new Map<string, Customer & { tenantId: string }>();
  private orders = new Map<string, Order & { tenantId: string }>();
  private kb = new Map<string, { slug: string; title: string; content: string }[]>();
  readonly refunds: (RefundRecord & { tenantId: string; id: string; createdAt: number })[] = [];
  readonly addressChanges: { tenantId: string; orderId: string; address: Address }[] = [];
  readonly tickets: (TicketSummary & { tenantId: string; customerId: string })[] = [];

  constructor(tenants: { config: TenantConfig; kb: { slug: string; markdown: string }[] }[]) {
    const now = Date.now();
    const daysAgo = (n?: number) =>
      n === undefined ? null : new Date(now - n * 86_400_000).toISOString();
    for (const { config, kb } of tenants) {
      const tenantId = MemoryRepo.tenantId(config.slug);
      this.settings.set(tenantId, { ...config.settings, kill_switch: false });
      for (const c of config.customers) {
        const id = stableUuid("customer", config.slug, c.key);
        this.customers.set(id, {
          id,
          tenantId,
          email: c.email,
          name: c.name,
          preferredLanguage: c.preferred_language,
          plan: c.plan,
        });
      }
      for (const o of config.orders) {
        const id = stableUuid("order", config.slug, o.order_number);
        const charges = o.duplicate_charge ? 2 : 1;
        this.orders.set(id, {
          id,
          tenantId,
          orderNumber: o.order_number,
          customerId: stableUuid("customer", config.slug, o.customer),
          status: o.status,
          currency: o.currency,
          totalCents: o.total_cents,
          items: o.items,
          carrier: o.carrier,
          trackingNumber: o.tracking_number,
          estimatedDelivery:
            o.estimated_delivery_in_days === undefined
              ? null
              : new Date(now + o.estimated_delivery_in_days * 86_400_000)
                  .toISOString()
                  .slice(0, 10),
          placedAt: daysAgo(o.placed_days_ago)!,
          shippedAt: daysAgo(o.shipped_days_ago),
          deliveredAt: daysAgo(o.delivered_days_ago),
          shippingAddress: o.shipping_address ?? {},
          capturedPayments: charges,
          capturedCents: charges * o.total_cents,
          refundedCents: 0,
        });
      }
      this.kb.set(
        tenantId,
        kb.flatMap((d) => {
          const { title, chunks } = chunkMarkdown(d.markdown);
          return chunks.map((content) => ({ slug: d.slug, title, content }));
        }),
      );
    }
  }

  static tenantId(slug: string) {
    return stableUuid("tenant", slug);
  }

  setKillSwitch(tenantId: string, on: boolean) {
    this.settings.get(tenantId)!.kill_switch = on;
  }

  setRolloutMode(tenantId: string, mode: TenantSettings["rollout_mode"]) {
    this.settings.get(tenantId)!.rollout_mode = mode;
  }

  findCustomerByEmail(tenantId: string, email: string) {
    return (
      [...this.customers.values()].find(
        (c) => c.tenantId === tenantId && c.email === email.toLowerCase(),
      ) ?? null
    );
  }

  async getSettings(tenantId: string) {
    const s = this.settings.get(tenantId);
    if (!s) throw new Error("unknown tenant");
    return structuredClone(s);
  }

  async getCustomer(tenantId: string, customerId: string) {
    const c = this.customers.get(customerId);
    return c && c.tenantId === tenantId
      ? {
          id: c.id,
          email: c.email,
          name: c.name,
          preferredLanguage: c.preferredLanguage,
          plan: c.plan,
        }
      : null;
  }

  async listOrders(tenantId: string, customerId: string) {
    return [...this.orders.values()]
      .filter((o) => o.tenantId === tenantId && o.customerId === customerId)
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
      .map((o) => {
        const copy: Partial<typeof o> = structuredClone(o);
        delete copy.tenantId; // callers get the plain domain Order
        return copy as Order;
      });
  }

  async listTicketHistory(
    tenantId: string,
    customerId: string,
    excludeTicketId: string,
    limit: number,
  ) {
    return this.tickets
      .filter(
        (t) => t.tenantId === tenantId && t.customerId === customerId && t.id !== excludeTicketId,
      )
      .slice(0, limit);
  }

  async searchKb(tenantId: string, query: string, k: number): Promise<KbHit[]> {
    const docs = this.kb.get(tenantId) ?? [];
    const terms = tokenize(query);
    const N = docs.length || 1;
    const df = new Map<string, number>();
    const tokenized = docs.map((d) => tokenize(d.content));
    for (const toks of tokenized) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    const avgLen = tokenized.reduce((s, t) => s + t.length, 0) / N;
    return docs
      .map((d, i) => {
        const toks = tokenized[i];
        let score = 0;
        for (const term of terms) {
          const tf = toks.filter((t) => t === term).length;
          if (!tf) continue;
          const idf = Math.log(1 + (N - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
          score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (toks.length / avgLen))));
        }
        return { ...d, score, similarity: null };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async countRefundsLast30Days(tenantId: string, customerId: string) {
    const since = Date.now() - 30 * 86_400_000;
    return this.refunds.filter(
      (r) =>
        r.tenantId === tenantId &&
        r.customerId === customerId &&
        r.status === "approved" &&
        r.createdAt > since,
    ).length;
  }

  /** Same rules as the create_refund_checked SQL function (idempotency, balance, frequency). */
  async createRefund(
    tenantId: string,
    refund: RefundRecord,
  ): Promise<{ id: string | null; outcome: RefundOutcome }> {
    const order = this.orders.get(refund.orderId);
    if (!order || order.tenantId !== tenantId || order.customerId !== refund.customerId) {
      return { id: null, outcome: "order_not_found" };
    }
    const existing = this.refunds.find(
      (r) => r.tenantId === tenantId && r.idempotencyKey === refund.idempotencyKey,
    );
    if (existing) return { id: existing.id, outcome: "duplicate" };
    if (refund.amountCents <= 0 || order.refundedCents + refund.amountCents > order.capturedCents) {
      return { id: null, outcome: "exceeds_balance" };
    }
    if (
      refund.status === "approved" &&
      (await this.countRefundsLast30Days(tenantId, refund.customerId)) >= refund.maxRefunds30d
    ) {
      return { id: null, outcome: "frequency_limit" };
    }
    const id = `refund-${this.refunds.length + 1}`;
    this.refunds.push({ ...refund, tenantId, id, createdAt: Date.now() });
    order.refundedCents += refund.amountCents;
    return { id, outcome: "created" };
  }

  async updateShippingAddress(tenantId: string, orderId: string, address: Address) {
    const order = this.orders.get(orderId);
    if (!order || order.tenantId !== tenantId) throw new Error("order not found");
    // Mirrors the SQL write's status guard: never change the address of a shipped order.
    if (!["pending", "processing"].includes(order.status))
      throw new Error("order not updatable (already shipped)");
    order.shippingAddress = address;
    this.addressChanges.push({ tenantId, orderId, address });
  }

  async sampleOrderNumbers(tenantId: string) {
    return [...this.orders.values()]
      .filter((o) => o.tenantId === tenantId)
      .slice(0, 4)
      .map((o) => o.orderNumber);
  }
}

const STOP = new Set(
  "a an and are as at be by can do for from how i if in is it my of on or our the to was we what when where which with you your".split(
    " ",
  ),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => t.replace(/(ing|ed|es|s)$/, "")); // crude stemming is enough for a small help center
}
