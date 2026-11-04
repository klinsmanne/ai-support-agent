import Link from "next/link";
import type { Membership } from "@/lib/auth/server";

/** Tenant switcher: one tab per company the user belongs to (each fully isolated). */
export function TenantTabs({
  memberships,
  current,
  path,
}: {
  memberships: Membership[];
  current: string;
  path: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2" role="tablist" aria-label="Company">
      {memberships.map((m) => (
        <Link
          key={m.slug}
          role="tab"
          aria-selected={m.slug === current}
          href={`${path}?t=${m.slug}`}
          className={
            m.slug === current
              ? "rounded-full bg-zinc-900 px-3 py-1 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "rounded-full border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          }
        >
          {m.name} <span className="opacity-60">· {m.role}</span>
        </Link>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const color: Record<string, string> = {
    resolved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
    awaiting_customer: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
    escalated: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
    needs_attention: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
    closed: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${color[status] ?? "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
