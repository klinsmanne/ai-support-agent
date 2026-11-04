import "server-only";
import { cacheLife } from "next/cache";
import { createServiceClient } from "@/lib/db/client";
import { parseServerEnv } from "@/lib/env";

/** Only the fictional demo companies are ever counted publicly — never a real client tenant. */
const PUBLIC_TENANT_SLUGS = ["harbor-pine", "cadence-analytics"];

export interface PublicStats {
  handled: number;
  autoResolved: number;
  escalated: number;
  autoResolutionRate: number | null;
  /** Handled-weighted average of each tenant's median (approximate; the dashboard is exact). */
  typicalFirstResponseSeconds: number | null;
  injectionFlagged: number;
  spamClosed: number;
}

/**
 * Aggregate, anonymous numbers for the public landing page (last 30 days, demo tenants only).
 * Only counts leave this function — never ticket content, emails or IDs. "use cache" puts the
 * result in the page's static shell and refreshes it every few minutes, so a busy landing page
 * costs one small query, not one per visitor. Returns null (the page shows "—") when the
 * database isn't configured (e.g. CI builds) or any query fails, rather than showing wrong zeros.
 */
export async function getPublicStats(): Promise<PublicStats | null> {
  "use cache";
  cacheLife("minutes");
  try {
    const env = parseServerEnv(process.env);
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return null;
    const db = createServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const { data: tenants, error } = await db
      .from("tenants")
      .select("id")
      .in("slug", PUBLIC_TENANT_SLUGS);
    if (error || !tenants?.length) return null;
    const results = await Promise.all(
      tenants.map((t) => db.rpc("dashboard_metrics", { p_tenant_id: t.id, p_days: 30 })),
    );
    if (results.some((r) => r.error || !r.data)) return null;
    const rows = results.map((r) => r.data as Record<string, number | null>);
    const sum = (k: string) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    const handled = sum("handled");
    const autoResolved = sum("auto_resolved");
    let weight = 0;
    let weighted = 0;
    for (const r of rows) {
      const m = r.median_first_response_seconds;
      const w = Number(r.handled) || 0;
      if (typeof m === "number" && w > 0) {
        weighted += m * w;
        weight += w;
      }
    }
    return {
      handled,
      autoResolved,
      escalated: sum("escalated"),
      autoResolutionRate: handled ? autoResolved / handled : null,
      typicalFirstResponseSeconds: weight ? weighted / weight : null,
      injectionFlagged: sum("injection_flagged"),
      spamClosed: sum("spam_closed"),
    };
  } catch {
    return null;
  }
}
