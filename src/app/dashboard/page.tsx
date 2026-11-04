import Link from "next/link";
import { Suspense } from "react";
import { Stat, TenantTabs } from "@/components/dashboard/TenantTabs";
import { dashboardContext, fmtPct, fmtSeconds } from "@/lib/dashboard/context";
import { getMetrics, listPendingEscalations } from "@/lib/dashboard/data";
import { getUsageToday, PLATFORM_LIMITS } from "@/lib/dashboard/usage";
import { getContainer } from "@/lib/server/container";

export default function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; days?: string }>;
}) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading metrics…</p>}>
      <Overview searchParams={searchParams} />
    </Suspense>
  );
}

async function Overview({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; days?: string }>;
}) {
  const { t, days: d } = await searchParams;
  const days = [7, 30, 90].includes(Number(d)) ? Number(d) : 30;
  const ctx = await dashboardContext(t);
  const [m, pending, usage] = await Promise.all([
    getMetrics(ctx.db, ctx.tenant.tenantId, days),
    listPendingEscalations(ctx.db, ctx.tenant.tenantId),
    getUsageToday(getContainer().db),
  ]);
  const num = (k: string) => Number(m?.[k] ?? 0);
  const cost = m?.cost_per_ticket_usd as number | null;

  return (
    <div className="space-y-8">
      <TenantTabs
        memberships={ctx.viewer.memberships}
        current={ctx.tenant.slug}
        path="/dashboard"
      />

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Business impact · last {days} days</h2>
          <div className="flex gap-1 text-xs">
            {[7, 30, 90].map((n) => (
              <Link
                key={n}
                href={`/dashboard?t=${ctx.tenant.slug}&days=${n}`}
                className={`rounded-md px-2 py-1 ${n === days ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "border border-zinc-300 dark:border-zinc-700"}`}
              >
                {n}d
              </Link>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Auto-resolution rate"
            value={fmtPct(m?.auto_resolution_rate as number | null)}
            hint={`${num("auto_resolved")} of ${num("handled")} tickets · target ≥ 50%`}
          />
          <Stat
            label="Escalation rate"
            value={fmtPct(m?.escalation_rate as number | null)}
            hint={`${num("escalated")} escalated · ${num("assisted")} AI-drafted`}
          />
          <Stat
            label="Median first response"
            value={fmtSeconds(m?.median_first_response_seconds as number | null)}
            hint="baseline 9.5 h · target < 2 min"
          />
          <Stat
            label="Agent hours saved"
            value={`${num("hours_saved")} h`}
            hint="8 min per auto-resolved ticket"
          />
          <Stat
            label="Cost per ticket"
            value={cost === null || cost === undefined ? "—" : `$${cost.toFixed(2)}`}
            hint="vs $7.80 human baseline (AI at paid-tier list prices)"
          />
          <Stat
            label="CSAT"
            value={m?.csat_avg ? `${Number(m.csat_avg).toFixed(1)} / 5` : "—"}
            hint={`${num("csat_count")} ratings`}
          />
          <Stat
            label="Spam & auto-replies closed"
            value={String(num("spam_closed"))}
            hint="no model cost, no reply"
          />
          <Stat
            label="Injection attempts flagged"
            value={String(num("injection_flagged"))}
            hint="sent to human review"
          />
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-semibold">Waiting for a human</h3>
            <Link
              href={`/dashboard/escalations?t=${ctx.tenant.slug}`}
              className="text-xs underline"
            >
              View all
            </Link>
          </div>
          {pending.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing pending. 🎉</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {pending.slice(0, 5).map((e) => (
                <li key={e.id}>
                  <Link
                    href={`/dashboard/tickets/${e.ticket_id}?t=${ctx.tenant.slug}`}
                    className="hover:underline"
                  >
                    {(e.reason_codes as string[]).join(", ")} — {String(e.summary).slice(0, 80)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-zinc-500">
            {num("needs_attention")} ticket(s) need attention · {num("agent_runs")} agent runs ·
            median agent latency{" "}
            {m?.median_agent_latency_ms
              ? `${(Number(m.median_agent_latency_ms) / 1000).toFixed(1)} s`
              : "—"}
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <h3 className="mb-3 font-semibold">Free-tier usage today</h3>
          <ul className="space-y-3 text-sm">
            {usage.map((u) => (
              <li key={u.key}>
                <div className="flex justify-between">
                  <span>{u.label}</span>
                  <span
                    className={`tabular-nums ${u.level === "ok" ? "" : "font-semibold text-red-600"}`}
                  >
                    {u.used.toLocaleString()} / {u.limit.toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-900">
                  <div
                    className={`h-1.5 rounded-full ${u.level === "ok" ? "bg-emerald-500" : u.level === "warn" ? "bg-amber-500" : "bg-red-600"}`}
                    style={{ width: `${Math.min(100, Math.round(u.pct * 100))}%` }}
                  />
                </div>
                {u.level !== "ok" && (
                  <p className="mt-1 text-xs text-red-600">
                    Approaching the free limit — the router will fall back to other models.
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-zinc-500">
            Limits are estimates ({PLATFORM_LIMITS.map((p) => `${p.label}: ${p.limit}`).join(" · ")}
            ).
          </p>
        </div>
      </section>
    </div>
  );
}
