import Link from "next/link";
import { Suspense } from "react";
import { StatusPill, TenantTabs } from "@/components/dashboard/TenantTabs";
import { dashboardContext, fmtDate } from "@/lib/dashboard/context";
import { listTickets, TICKET_STATUSES } from "@/lib/dashboard/data";

type Params = Promise<{ t?: string; status?: string; channel?: string; q?: string }>;

export default function TicketsPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading tickets…</p>}>
      <Tickets searchParams={searchParams} />
    </Suspense>
  );
}

async function Tickets({ searchParams }: { searchParams: Params }) {
  const sp = await searchParams;
  const ctx = await dashboardContext(sp.t);
  const tickets = await listTickets(ctx.db, ctx.tenant.tenantId, sp);
  return (
    <div>
      <TenantTabs
        memberships={ctx.viewer.memberships}
        current={ctx.tenant.slug}
        path="/dashboard/tickets"
      />
      <form className="mb-4 flex flex-wrap gap-2 text-sm" role="search">
        <input type="hidden" name="t" value={ctx.tenant.slug} />
        <input
          name="q"
          defaultValue={sp.q}
          placeholder="Search subject, email, intent…"
          className="min-w-56 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
        />
        <select
          name="status"
          defaultValue={sp.status ?? ""}
          aria-label="Status"
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">All statuses</option>
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <select
          name="channel"
          defaultValue={sp.channel ?? ""}
          aria-label="Channel"
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">All channels</option>
          <option value="email">Email</option>
          <option value="chat">Chat</option>
        </select>
        <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-white dark:bg-zinc-100 dark:text-zinc-900">
          Filter
        </button>
      </form>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
            <tr>
              <th className="px-3 py-2">Ticket</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Intent</th>
              <th className="px-3 py-2">Channel</th>
              <th className="px-3 py-2">Updated</th>
            </tr>
          </thead>
          <tbody>
            {tickets.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">
                  No tickets match. Try the chat widget on the home page to create one.
                </td>
              </tr>
            )}
            {tickets.map((tk) => (
              <tr
                key={tk.id}
                className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/50"
              >
                <td className="px-3 py-2">
                  <Link
                    href={`/dashboard/tickets/${tk.id}?t=${ctx.tenant.slug}`}
                    className="font-medium hover:underline"
                  >
                    {tk.subject ?? "(no subject)"}
                  </Link>
                  <div className="text-xs text-zinc-500">
                    {tk.requester_email ?? "anonymous"}{" "}
                    {tk.sender_verified ? "· ✓ verified" : "· unverified"}
                    {tk.injection_suspected && (
                      <span className="ml-1 text-red-600">· ⚠ injection flagged</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={tk.status} />
                </td>
                <td className="px-3 py-2 text-xs">
                  {tk.intent ?? "—"}
                  {tk.language ? ` · ${tk.language}` : ""}
                </td>
                <td className="px-3 py-2 text-xs">{tk.channel}</td>
                <td className="px-3 py-2 text-xs text-zinc-500">{fmtDate(tk.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
