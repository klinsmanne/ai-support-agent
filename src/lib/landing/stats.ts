import "server-only";
import { cacheLife } from "next/cache";
import { createClient } from "@supabase/supabase-js";

export interface PublicStats {
  handled: number;
  autoResolved: number;
  escalated: number;
  autoResolutionRate: number | null;
  medianFirstResponseSeconds: number | null;
  injectionFlagged: number;
  spamClosed: number;
}

/**
 * Aggregate, anonymous numbers for the public landing page (last 30 days, both demo tenants).
 * Only counts leave this function — never ticket content, emails or IDs. Cached for minutes so
 * a busy landing page costs one small query, not one per visitor. Returns null (the page shows
 * "—") when the database isn't configured, e.g. in CI builds.
 */
export async function getPublicStats(): Promise<PublicStats | null> {
  "use cache";
  cacheLife("minutes");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  try {
    const db = createClient(url, key, { auth: { persistSession: false } });
    const { data: tenants, error } = await db.from("tenants").select("id");
    if (error || !tenants?.length) return null;
    const rows = await Promise.all(
      tenants.map(async (t) => {
        const { data } = await db.rpc("dashboard_metrics", { p_tenant_id: t.id, p_days: 30 });
        return (data ?? {}) as Record<string, number | null>;
      }),
    );
    const sum = (k: string) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    const handled = sum("handled");
    const autoResolved = sum("auto_resolved");
    // Median of medians is close enough for a headline number; the dashboard has exact values.
    const frts = rows
      .map((r) => r.median_first_response_seconds)
      .filter((v): v is number => typeof v === "number");
    return {
      handled,
      autoResolved,
      escalated: sum("escalated"),
      autoResolutionRate: handled ? autoResolved / handled : null,
      medianFirstResponseSeconds: frts.length
        ? frts.sort((a, b) => a - b)[Math.floor(frts.length / 2)]
        : null,
      injectionFlagged: sum("injection_flagged"),
      spamClosed: sum("spam_closed"),
    };
  } catch {
    return null;
  }
}
