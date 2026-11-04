import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EscalationPanel } from "@/components/dashboard/EscalationPanel";
import { StatusPill } from "@/components/dashboard/TenantTabs";
import { dashboardContext, fmtDate } from "@/lib/dashboard/context";
import { getTicketDetail } from "@/lib/dashboard/data";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> };

export default function TicketPage(props: Props) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading ticket…</p>}>
      <Ticket {...props} />
    </Suspense>
  );
}

const TYPE_STYLE: Record<string, string> = {
  model_call: "border-sky-300 dark:border-sky-800",
  tool_call: "border-violet-300 dark:border-violet-800",
  retrieval: "border-emerald-300 dark:border-emerald-800",
  guardrail: "border-amber-300 dark:border-amber-800",
  decision: "border-zinc-400 dark:border-zinc-600",
  error: "border-red-400 dark:border-red-800",
};

async function Ticket({ params, searchParams }: Props) {
  const [{ id }, { t }] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const ctx = await dashboardContext(t);
  const detail = await getTicketDetail(ctx.db, ctx.tenant.tenantId, id);
  if (!detail) notFound(); // also what another tenant's ticket looks like: RLS hides it
  const { ticket, messages, runs, escalations, audit } = detail;
  const pending = escalations.filter((e) => e.status === "pending");

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/dashboard/tickets?t=${ctx.tenant.slug}`}
          className="text-xs text-zinc-500 hover:underline"
        >
          ← {ctx.tenant.name} tickets
        </Link>
        <h1 className="mt-1 text-xl font-semibold">{ticket.subject ?? "(no subject)"}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <StatusPill status={ticket.status} />
          <span>{ticket.channel}</span>
          <span>
            · {ticket.requester_email ?? "anonymous"}{" "}
            {ticket.sender_verified ? "(✓ verified)" : "(unverified)"}
          </span>
          {ticket.intent && <span>· intent {ticket.intent}</span>}
          {ticket.sentiment !== null && <span>· sentiment {ticket.sentiment}</span>}
          {ticket.language && <span>· {ticket.language}</span>}
          {ticket.injection_suspected && (
            <span className="font-medium text-red-600">· ⚠ prompt injection suspected</span>
          )}
        </div>
      </div>

      {pending.map((e) => (
        <section
          key={e.id}
          className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30"
        >
          <h2 className="font-semibold">
            Needs a human · {(e.reason_codes as string[]).join(", ").replace(/_/g, " ")}
          </h2>
          <p className="mt-1 text-sm">{e.summary}</p>
          <Investigation data={e.investigation} />
          <div className="mt-3">
            <EscalationPanel
              tenantId={ctx.tenant.tenantId}
              escalationId={e.id}
              suggestedReply={e.suggested_reply}
              canEdit={ctx.canEdit}
              pendingAction={
                e.pending_action
                  ? `${e.pending_action.type} on order ${e.pending_action.orderNumber} (${(Number(e.pending_action.amountCents) / 100).toFixed(2)})`
                  : null
              }
            />
          </div>
        </section>
      ))}

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 font-semibold">Conversation</h2>
          <ol className="space-y-3">
            {messages.map((m) => (
              <li
                key={m.id}
                className={`rounded-lg border p-3 text-sm ${m.direction === "inbound" ? "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" : "border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900"}`}
              >
                <div className="mb-1 flex justify-between text-xs text-zinc-500">
                  <span>
                    {m.author === "customer"
                      ? "Customer"
                      : m.author === "ai"
                        ? "AI agent"
                        : "Support team"}{" "}
                    · {m.status.replace(/_/g, " ")}
                  </span>
                  <span>{fmtDate(m.created_at)}</span>
                </div>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </li>
            ))}
          </ol>
        </div>

        <div>
          <h2 className="mb-2 font-semibold">Agent trace</h2>
          {runs.length === 0 && (
            <p className="text-sm text-zinc-500">
              No agent runs (filtered before the model, or handled by a human).
            </p>
          )}
          {runs.map((r) => (
            <details
              key={r.id}
              open={r === runs[0]}
              className="mb-3 rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <summary className="cursor-pointer">
                <span className="font-medium">{r.outcome ?? r.status}</span>{" "}
                <span className="text-xs text-zinc-500">
                  · {r.provider}:{r.model} · {r.steps} steps · {r.tokens_in + r.tokens_out} tokens ·{" "}
                  {((r.latency_ms ?? 0) / 1000).toFixed(1)} s · ${Number(r.est_cost_usd).toFixed(5)}{" "}
                  est. · prompt {r.prompt_version}
                </span>
              </summary>
              <ol className="mt-3 space-y-2">
                {r.trace_events.map((ev) => (
                  <li key={ev.seq} className={`border-l-4 pl-3 ${TYPE_STYLE[ev.type] ?? ""}`}>
                    <div className="text-xs">
                      <span className="font-medium">
                        {ev.seq}. {ev.name}
                      </span>{" "}
                      <span className="text-zinc-500">
                        ({ev.type.replace(/_/g, " ")}
                        {ev.latency_ms ? ` · ${ev.latency_ms} ms` : ""}
                        {ev.tokens_in ? ` · ${ev.tokens_in}+${ev.tokens_out} tok` : ""})
                      </span>
                    </div>
                    {ev.input !== null && ev.input !== undefined && (
                      <pre className="mt-1 max-h-40 overflow-auto rounded bg-zinc-50 p-2 text-[11px] dark:bg-zinc-900">
                        in: {JSON.stringify(ev.input, null, 1)}
                      </pre>
                    )}
                    {ev.output !== null && ev.output !== undefined && (
                      <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-50 p-2 text-[11px] dark:bg-zinc-900">
                        out: {JSON.stringify(ev.output, null, 1)}
                      </pre>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          ))}
          <h3 className="mt-6 mb-2 font-semibold">Audit log</h3>
          <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
            {audit.map((a, i) => (
              <li key={i}>
                {fmtDate(a.created_at)} · <span className="font-medium">{a.actor_type}</span> ·{" "}
                {a.action}
                {a.reason ? ` — ${a.reason}` : ""}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function Investigation({ data }: { data: unknown }) {
  const inv = (data ?? {}) as {
    tools?: { name: string }[];
    citations?: { slug: string; title: string }[];
    actions?: { type: string; status: string; orderNumber: string }[];
  };
  if (!inv.tools?.length && !inv.citations?.length) return null;
  return (
    <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
      Investigated: {inv.tools?.map((tl) => tl.name).join(" → ") || "—"}
      {inv.citations?.length
        ? ` · sources: ${[...new Set(inv.citations.map((c) => c.slug))].join(", ")}`
        : ""}
      {inv.actions?.length
        ? ` · actions: ${inv.actions.map((a) => `${a.type} ${a.orderNumber} (${a.status})`).join(", ")}`
        : ""}
    </div>
  );
}
