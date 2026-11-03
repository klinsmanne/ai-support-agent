import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AgentRepo,
  Address,
  KbHit,
  Order,
  RefundOutcome,
  RefundRecord,
} from "../agent/domain.ts";
import type { TenantSettings } from "../tenants/config.ts";
import { toVectorLiteral } from "../llm/embeddings.ts";

/**
 * Production AgentRepo on Supabase. Uses the service-role client (bypasses RLS), so EVERY query
 * filters by tenant_id explicitly — defense in depth on top of the composite tenant foreign keys.
 */
export class SupabaseRepo implements AgentRepo {
  constructor(
    private readonly db: SupabaseClient,
    /** Embeds a search query (RETRIEVAL_QUERY); null disables the vector leg (keyword only). */
    private readonly embedQuery: ((text: string) => Promise<number[]>) | null,
  ) {}

  async getSettings(tenantId: string) {
    const { data, error } = await this.db
      .from("tenant_settings")
      .select("*")
      .eq("tenant_id", tenantId)
      .single();
    if (error) throw new Error(`settings: ${error.message}`);
    return data as TenantSettings & { kill_switch: boolean };
  }

  async getCustomer(tenantId: string, customerId: string) {
    const { data, error } = await this.db
      .from("customers")
      .select("id, email, name, preferred_language, plan")
      .eq("tenant_id", tenantId)
      .eq("id", customerId)
      .maybeSingle();
    if (error) throw new Error(`customer: ${error.message}`);
    return data
      ? {
          id: data.id,
          email: data.email,
          name: data.name,
          preferredLanguage: data.preferred_language,
          plan: data.plan,
        }
      : null;
  }

  async listOrders(tenantId: string, customerId: string): Promise<Order[]> {
    const { data, error } = await this.db
      .from("orders")
      .select("*, payments(amount_cents, status), refunds(amount_cents, status)")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .order("placed_at", { ascending: false })
      .limit(25);
    if (error) throw new Error(`orders: ${error.message}`);
    return (data ?? []).map((o) => {
      const payments = (o.payments ?? []) as { amount_cents: number; status: string }[];
      const refunds = (o.refunds ?? []) as { amount_cents: number; status: string }[];
      // Refunds are tracked in the refunds table (payment rows are never mutated), so every
      // payment counts as captured and the balance is captured − approved/pending refunds.
      const captured = payments;
      return {
        id: o.id,
        orderNumber: o.order_number,
        customerId: o.customer_id,
        status: o.status,
        currency: o.currency,
        totalCents: o.total_cents,
        items: o.items,
        carrier: o.carrier,
        trackingNumber: o.tracking_number,
        estimatedDelivery: o.estimated_delivery,
        placedAt: o.placed_at,
        shippedAt: o.shipped_at,
        deliveredAt: o.delivered_at,
        shippingAddress: o.shipping_address,
        capturedPayments: captured.length,
        capturedCents: captured.reduce((s, p) => s + p.amount_cents, 0),
        // Matches create_refund_checked: pending refunds also reserve balance.
        refundedCents: refunds
          .filter((r) => r.status === "approved" || r.status === "pending_approval")
          .reduce((s, r) => s + r.amount_cents, 0),
      };
    });
  }

  async listTicketHistory(
    tenantId: string,
    customerId: string,
    excludeTicketId: string,
    limit: number,
  ) {
    const { data, error } = await this.db
      .from("tickets")
      .select("id, subject, status, intent, created_at")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .neq("id", excludeTicketId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`tickets: ${error.message}`);
    return (data ?? []).map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      intent: t.intent,
      createdAt: t.created_at,
    }));
  }

  async searchKb(tenantId: string, query: string, k: number): Promise<KbHit[]> {
    let embedding: string | null = null;
    if (this.embedQuery) {
      try {
        embedding = toVectorLiteral(await this.embedQuery(query));
      } catch {
        embedding = null; // embedding outage degrades to keyword-only search instead of failing
      }
    }
    const { data, error } = await this.db.rpc("match_kb_chunks", {
      p_tenant_id: tenantId,
      p_query_embedding: embedding,
      p_query_text: query,
      p_match_count: k,
    });
    if (error) throw new Error(`kb search: ${error.message}`);
    return (data ?? []).map(
      (h: {
        slug: string;
        title: string;
        content: string;
        score: number;
        similarity: number | null;
      }) => ({
        slug: h.slug,
        title: h.title,
        content: h.content,
        score: h.score,
        similarity: h.similarity,
      }),
    );
  }

  async countRefundsLast30Days(tenantId: string, customerId: string) {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { count, error } = await this.db
      .from("refunds")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .eq("status", "approved")
      .gte("created_at", since);
    if (error) throw new Error(`refund count: ${error.message}`);
    return count ?? 0;
  }

  async createRefund(tenantId: string, r: RefundRecord) {
    // Atomic check-and-insert under a row lock on the order (migration ..._atomic_refund.sql).
    const { data, error } = await this.db.rpc("create_refund_checked", {
      p_tenant_id: tenantId,
      p_order_id: r.orderId,
      p_customer_id: r.customerId,
      p_ticket_id: r.ticketId,
      p_amount_cents: r.amountCents,
      p_reason: r.reason,
      p_status: r.status,
      p_idempotency_key: r.idempotencyKey,
      p_max_refunds_30d: r.maxRefunds30d,
    });
    if (error) throw new Error(`refund: ${error.message}`);
    const row = (data as { refund_id: string | null; outcome: RefundOutcome }[])[0];
    return { id: row?.refund_id ?? null, outcome: row?.outcome ?? "order_not_found" };
  }

  async updateShippingAddress(tenantId: string, orderId: string, address: Address) {
    const { error, count } = await this.db
      .from("orders")
      .update({ shipping_address: address }, { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("id", orderId)
      .in("status", ["pending", "processing"]); // re-checked atomically in the write itself
    if (error) throw new Error(`address: ${error.message}`);
    if (!count) throw new Error("order not updatable (already shipped or not found)");
  }

  async sampleOrderNumbers(tenantId: string) {
    const { data } = await this.db
      .from("orders")
      .select("order_number")
      .eq("tenant_id", tenantId)
      .order("order_number")
      .limit(4);
    return (data ?? []).map((o) => o.order_number);
  }
}
