import { pollGmail } from "@/lib/channels/email/poll";
import { maskPII } from "@/lib/guardrails/pii";
import { getContainer, isAuthorizedCron } from "@/lib/server/container";

// Each ticket may take up to ~45 s; Vercel Hobby allows functions up to 300 s.
export const maxDuration = 300;

/** Called every ~2 minutes by Supabase pg_cron (signed with CRON_SECRET). */
export async function POST(request: Request) {
  if (!isAuthorizedCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const c = getContainer();
  if (!c.gmail) return Response.json({ error: "gmail not configured" }, { status: 503 });
  const report = await pollGmail(c.gmail, c.deps, await c.defaultTenantId());
  return Response.json({ ...report, error: report.error ? maskPII(report.error) : undefined });
}
