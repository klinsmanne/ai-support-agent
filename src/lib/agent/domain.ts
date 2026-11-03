import type { TenantSettings } from "../tenants/config.ts";

/** Domain types shared by the agent, tools, policy engine and repositories. */

export type OrderStatus =
  "pending" | "processing" | "shipped" | "delayed" | "delivered" | "cancelled" | "returned";

export interface Address {
  line1: string;
  city: string;
  region?: string;
  postal_code: string;
  country: string;
}

export interface Customer {
  id: string;
  email: string;
  name: string;
  preferredLanguage: string;
  plan?: string | null;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  status: OrderStatus;
  currency: string;
  totalCents: number;
  items: { sku: string; name: string; qty: number; price_cents: number; final_sale?: boolean }[];
  carrier?: string | null;
  trackingNumber?: string | null;
  estimatedDelivery?: string | null;
  placedAt: string;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  shippingAddress: Partial<Address>;
  /** Captured payments for this order (2 = a duplicate charge). */
  capturedPayments: number;
  capturedCents: number;
  refundedCents: number;
}

export interface TicketSummary {
  id: string;
  subject: string | null;
  status: string;
  intent: string | null;
  createdAt: string;
}

export interface KbHit {
  slug: string;
  title: string;
  content: string;
  score: number;
  similarity: number | null;
}

export type RefundReason =
  "duplicate_charge" | "damaged_item" | "lost_package" | "not_as_described" | "other";

export interface RefundRecord {
  orderId: string;
  customerId: string;
  ticketId: string;
  amountCents: number;
  reason: string;
  status: "approved" | "pending_approval";
  idempotencyKey: string;
}

/** Tenant-scoped data access used by the agent. Every method takes tenantId explicitly. */
export interface AgentRepo {
  getSettings(tenantId: string): Promise<TenantSettings & { kill_switch: boolean }>;
  getCustomer(tenantId: string, customerId: string): Promise<Customer | null>;
  listOrders(tenantId: string, customerId: string): Promise<Order[]>;
  listTicketHistory(
    tenantId: string,
    customerId: string,
    excludeTicketId: string,
    limit: number,
  ): Promise<TicketSummary[]>;
  searchKb(tenantId: string, query: string, k: number): Promise<KbHit[]>;
  countRefundsLast30Days(tenantId: string, customerId: string): Promise<number>;
  createRefund(tenantId: string, refund: RefundRecord): Promise<{ id: string; duplicate: boolean }>;
  updateShippingAddress(tenantId: string, orderId: string, address: Address): Promise<void>;
  /** Public sample order numbers for the demo note shown to unknown senders. */
  sampleOrderNumbers(tenantId: string): Promise<string[]>;
}
