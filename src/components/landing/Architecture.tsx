/**
 * The request path as a diagram built from plain HTML (no image, readable in light and dark mode,
 * stacks vertically on phones). Mirrors docs/SOLUTION_DESIGN.md §2.
 */
const STAGES = [
  {
    title: "Channels",
    items: ["Gmail inbox (polled, threaded)", "Website chat (verified sessions)"],
    note: "spam, auto-replies and loops filtered · every message deduplicated",
  },
  {
    title: "Ticket + guardrails in",
    items: ["Tenant routing", "Sender authentication (DMARC)", "Prompt-injection detection"],
    note: "inbound text is data, never instructions",
  },
  {
    title: "Agent",
    items: [
      "Classify: intent, urgency, sentiment",
      "Budgeted tool loop (8 steps / 45 s)",
      "Hybrid RAG over the client's KB",
    ],
    note: "Gemini → Groq fallback chain · Claude-ready",
  },
  {
    title: "Policy engine (code)",
    items: ["Refund limits + frequency", "Ownership + tenant checks", "One write action per run"],
    note: "the model requests; code approves",
  },
  {
    title: "Guardrails out",
    items: [
      "No internal data, secrets or other customers",
      "Allowlisted links only",
      "AI disclosure + human option",
    ],
    note: "one repair attempt, otherwise a human reviews",
  },
] as const;

export function Architecture() {
  return (
    <div>
      <ol className="grid gap-3 md:grid-cols-5">
        {STAGES.map((s, i) => (
          <li key={s.title} className="relative">
            <div className="h-full rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{i + 1}</p>
              <h3 className="mt-1 text-sm font-semibold">{s.title}</h3>
              <ul className="mt-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                {s.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ul>
              <p className="mt-3 border-t border-zinc-100 pt-2 text-[11px] text-zinc-500 dark:border-zinc-900">
                {s.note}
              </p>
            </div>
            {i < STAGES.length - 1 && (
              <span
                aria-hidden
                className="absolute top-1/2 -right-2.5 z-10 hidden -translate-y-1/2 text-zinc-400 md:block"
              >
                →
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
          <p className="font-semibold">Resolve</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Confident, within policy, verified customer: the reply is sent and the ticket closes.
          </p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          <p className="font-semibold">Escalate</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Over a limit, angry, low confidence, injection or a human requested: the customer gets a
            holding reply and the team gets a summary, the evidence and a draft to approve.
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Under it all: Supabase Postgres with row-level security on every table, pgvector, and a full
        trace of every model call, tool call and decision.
      </p>
    </div>
  );
}
