import type { SupabaseClient } from "@supabase/supabase-js";
import type { MemoryRepo } from "../../agent/memory-repo.ts";

export interface ChatSession {
  id: string;
  verifiedCustomerId: string | null;
  verificationAttempts: number;
}

/** Chat-session persistence and the order-number + email verification lookup. */
export interface ChatStore {
  getSession(tenantId: string, id: string): Promise<ChatSession | null>;
  createSession(tenantId: string, id: string, ipHash: string): Promise<ChatSession>;
  verifyCustomer(tenantId: string, orderNumber: string, email: string): Promise<string | null>;
  recordVerification(tenantId: string, sessionId: string, customerId: string | null): Promise<void>;
  customerEmail(tenantId: string, customerId: string): Promise<string | null>;
}

export class SupabaseChatStore implements ChatStore {
  constructor(private readonly db: SupabaseClient) {}

  async getSession(tenantId: string, id: string) {
    const { data } = await this.db
      .from("chat_sessions")
      .select("id, verified_customer_id, verification_attempts, created_at")
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .maybeSingle();
    if (!data) return null;
    // Sessions expire after 24 h; a stale token simply starts a new session.
    if (Date.now() - new Date(data.created_at).getTime() > 86_400_000) return null;
    await this.db
      .from("chat_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", id);
    return {
      id: data.id,
      verifiedCustomerId: data.verified_customer_id,
      verificationAttempts: data.verification_attempts,
    };
  }

  async createSession(tenantId: string, id: string, ipHash: string) {
    const { error } = await this.db
      .from("chat_sessions")
      .insert({ id, tenant_id: tenantId, ip_hash: ipHash });
    if (error) throw new Error(`chat session: ${error.message}`);
    return { id, verifiedCustomerId: null, verificationAttempts: 0 };
  }

  async verifyCustomer(tenantId: string, orderNumber: string, email: string) {
    const { data } = await this.db
      .from("orders")
      .select("customer_id, customers!inner(email)")
      .eq("tenant_id", tenantId)
      .eq("order_number", orderNumber)
      .eq("customers.email", email)
      .maybeSingle();
    return (data?.customer_id as string | undefined) ?? null;
  }

  /** Called only on success; attempt counting uses the atomic rate limiter, not this row. */
  async recordVerification(tenantId: string, sessionId: string, customerId: string | null) {
    if (!customerId) return;
    await this.db
      .from("chat_sessions")
      .update({ verified_customer_id: customerId })
      .eq("tenant_id", tenantId)
      .eq("id", sessionId);
  }

  async customerEmail(tenantId: string, customerId: string) {
    const { data } = await this.db
      .from("customers")
      .select("email")
      .eq("tenant_id", tenantId)
      .eq("id", customerId)
      .maybeSingle();
    return data?.email ?? null;
  }
}

/** In-memory ChatStore for tests, backed by the MemoryRepo's fixtures. */
export class MemoryChatStore implements ChatStore {
  sessions = new Map<string, ChatSession & { tenantId: string }>();
  constructor(private readonly repo: MemoryRepo) {}

  async getSession(tenantId: string, id: string) {
    const s = this.sessions.get(id);
    return s && s.tenantId === tenantId
      ? {
          id: s.id,
          verifiedCustomerId: s.verifiedCustomerId,
          verificationAttempts: s.verificationAttempts,
        }
      : null;
  }
  async createSession(tenantId: string, id: string) {
    const s = { id, tenantId, verifiedCustomerId: null, verificationAttempts: 0 };
    this.sessions.set(id, s);
    return { id, verifiedCustomerId: null, verificationAttempts: 0 };
  }
  async verifyCustomer(tenantId: string, orderNumber: string, email: string) {
    const customer = this.repo.findCustomerByEmail(tenantId, email);
    if (!customer) return null;
    const orders = await this.repo.listOrders(tenantId, customer.id);
    return orders.some((o) => o.orderNumber === orderNumber) ? customer.id : null;
  }
  async recordVerification(_tenantId: string, sessionId: string, customerId: string | null) {
    const s = this.sessions.get(sessionId)!;
    s.verificationAttempts++;
    if (customerId) s.verifiedCustomerId = customerId;
  }
  async customerEmail(tenantId: string, customerId: string) {
    return (await this.repo.getCustomer(tenantId, customerId))?.email ?? null;
  }
}
