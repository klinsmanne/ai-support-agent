import { buildDigest, type PendingEscalation } from "@/lib/pipeline/escalation-notify";
import { getContainer, isAuthorizedCron } from "@/lib/server/container";

/**
 * Daily escalation digest (ADR-027), called by Supabase pg_cron with CRON_SECRET. For each client
 * with a team address and the digest on, emails what's still waiting in the Escalations queue.
 */
export async function POST(request: Request) {
  if (!isAuthorizedCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const c = getContainer();
  if (!c.gmail) return Response.json({ error: "gmail not configured" }, { status: 503 });
  const appUrl = c.env.APP_URL;
  // Without the public URL every link in the digest would be broken.
  if (!appUrl) return Response.json({ error: "APP_URL not configured" }, { status: 503 });

  const { data: tenants, error } = await c.db
    .from("tenant_settings")
    .select("tenant_id, brand_name, escalation_notify_email")
    .not("escalation_notify_email", "is", null)
    .eq("escalation_digest", true);
  if (error) return Response.json({ error: "settings query failed" }, { status: 500 });

  const sent: string[] = [];
  for (const t of tenants ?? []) {
    const { data: rows } = await c.db
      .from("escalations")
      .select("ticket_id, reason_codes, summary, created_at")
      .eq("tenant_id", t.tenant_id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(50);
    const pending: PendingEscalation[] = (rows ?? []).map((r) => ({
      ticketId: r.ticket_id,
      reasons: r.reason_codes ?? [],
      summary: r.summary ?? "",
      createdAt: r.created_at,
    }));
    const digest = buildDigest(t.brand_name, pending, (id) => `${appUrl}/dashboard/tickets/${id}`);
    if (!digest) continue;
    try {
      await c.gmail.sendNew(t.escalation_notify_email, digest.subject, digest.body);
      sent.push(t.brand_name);
    } catch (error) {
      // One client's failure doesn't stop the others. Logged without the address (it's private).
      console.warn(
        `escalation digest failed for tenant ${String(t.tenant_id).slice(0, 8)}…: ${(error as Error).message.slice(0, 120)}`,
      );
    }
  }
  return Response.json({ digests: sent.length });
}
