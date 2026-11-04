import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Dashboard reads. Every function receives the *user-scoped* client (createUserClient), so Row
 * Level Security decides what is visible; the explicit tenant filter is for correctness, not
 * security. Writes never happen here — they go through server actions with role checks.
 */

export const TICKET_STATUSES = [
  "new",
  "in_progress",
  "awaiting_customer",
  "resolved",
  "escalated",
  "closed",
  "needs_attention",
] as const;

export interface TicketRow {
  id: string;
  subject: string | null;
  status: string;
  channel: string;
  intent: string | null;
  urgency: string | null;
  sentiment: number | null;
  language: string | null;
  requester_email: string | null;
  sender_verified: boolean;
  injection_suspected: boolean;
  created_at: string;
  updated_at: string;
}

export async function listTickets(
  db: SupabaseClient,
  tenantId: string,
  f: { status?: string; channel?: string; q?: string; limit?: number },
): Promise<TicketRow[]> {
  let query = db
    .from("tickets")
    .select(
      "id, subject, status, channel, intent, urgency, sentiment, language, requester_email, sender_verified, injection_suspected, created_at, updated_at",
    )
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(f.limit ?? 50);
  if (f.status && (TICKET_STATUSES as readonly string[]).includes(f.status))
    query = query.eq("status", f.status);
  if (f.channel === "email" || f.channel === "chat") query = query.eq("channel", f.channel);
  if (f.q) {
    // Escape PostgREST/LIKE metacharacters so search text can't alter the filter.
    const term = f.q
      .replace(/[%_,()*\\]/g, " ")
      .trim()
      .slice(0, 80);
    if (term)
      query = query.or(
        `subject.ilike.%${term}%,requester_email.ilike.%${term}%,intent.ilike.%${term}%`,
      );
  }
  const { data, error } = await query;
  if (error) throw new Error(`tickets: ${error.message}`);
  return (data ?? []) as TicketRow[];
}

export async function getTicketDetail(db: SupabaseClient, tenantId: string, ticketId: string) {
  const [ticket, messages, runs, escalations, audit] = await Promise.all([
    db.from("tickets").select("*").eq("tenant_id", tenantId).eq("id", ticketId).maybeSingle(),
    db
      .from("messages")
      .select("id, direction, author, status, body, created_at, sent_at")
      .eq("tenant_id", tenantId)
      .eq("ticket_id", ticketId)
      .order("created_at"),
    db
      .from("agent_runs")
      .select(
        "id, provider, model, prompt_version, status, outcome, confidence, steps, tokens_in, tokens_out, est_cost_usd, latency_ms, error, started_at, trace_events(seq, type, name, input, output, latency_ms, tokens_in, tokens_out)",
      )
      .eq("tenant_id", tenantId)
      .eq("ticket_id", ticketId)
      .order("started_at", { ascending: false }),
    db
      .from("escalations")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: false }),
    db
      .from("audit_log")
      .select("actor_type, action, reason, created_at")
      .eq("tenant_id", tenantId)
      .eq("entity_id", ticketId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (!ticket.data) return null;
  return {
    ticket: ticket.data,
    messages: messages.data ?? [],
    runs: (runs.data ?? []).map((r) => ({
      ...r,
      trace_events: [...(r.trace_events ?? [])].sort((a, b) => a.seq - b.seq),
    })),
    escalations: escalations.data ?? [],
    audit: audit.data ?? [],
  };
}

export async function listPendingEscalations(db: SupabaseClient, tenantId: string) {
  const { data } = await db
    .from("escalations")
    .select(
      "id, ticket_id, reason_codes, summary, suggested_reply, created_at, tickets(subject, requester_email, channel)",
    )
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(50);
  return data ?? [];
}

export type Metrics = Record<string, number | null> & {
  daily: { day: string; tickets: number; auto: number; escalated: number }[];
};

export async function getMetrics(
  db: SupabaseClient,
  tenantId: string,
  days = 30,
): Promise<Metrics | null> {
  const { data, error } = await db.rpc("dashboard_metrics", {
    p_tenant_id: tenantId,
    p_days: days,
  });
  if (error) throw new Error(`metrics: ${error.message}`);
  return data as Metrics;
}

export async function getSettings(db: SupabaseClient, tenantId: string) {
  const { data } = await db
    .from("tenant_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return data;
}
