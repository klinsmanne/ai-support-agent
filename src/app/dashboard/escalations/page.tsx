import Link from "next/link";
import { Suspense } from "react";
import { TenantTabs } from "@/components/dashboard/TenantTabs";
import { dashboardContext, fmtDate } from "@/lib/dashboard/context";
import { listPendingEscalations } from "@/lib/dashboard/data";

type Params = Promise<{ t?: string }>;

export default function EscalationsPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading escalations…</p>}>
      <Escalations searchParams={searchParams} />
    </Suspense>
  );
}

async function Escalations({ searchParams }: { searchParams: Params }) {
  const { t } = await searchParams;
  const ctx = await dashboardContext(t);
  const items = await listPendingEscalations(ctx.db, ctx.tenant.tenantId);
  return (
    <div>
      <TenantTabs
        memberships={ctx.viewer.memberships}
        current={ctx.tenant.slug}
        path="/dashboard/escalations"
      />
      <h1 className="mb-1 text-lg font-semibold">Human review queue</h1>
      <p className="mb-4 text-sm text-zinc-500">
        Oldest first. Each item shows why it escalated, a summary and the suggested reply; open the
        ticket to see what the agent investigated.
      </p>
      {items.length === 0 ? (
        <p className="rounded-xl border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          Nothing waiting. 🎉
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((e) => {
            const tk = (Array.isArray(e.tickets) ? e.tickets[0] : e.tickets) as {
              subject: string | null;
              requester_email: string | null;
              channel: string;
            } | null;
            return (
              <li
                key={e.id}
                className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`/dashboard/tickets/${e.ticket_id}?t=${ctx.tenant.slug}`}
                    className="font-medium hover:underline"
                  >
                    {tk?.subject ?? "(no subject)"}
                  </Link>
                  <span className="text-xs text-zinc-500">
                    {fmtDate(e.created_at)} · {tk?.channel}
                  </span>
                </div>
                <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                  {(e.reason_codes as string[]).join(", ").replace(/_/g, " ")}
                </p>
                <p className="mt-1 text-sm">{e.summary}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
