import Link from "next/link";
import { Suspense } from "react";
import { getViewer } from "@/lib/auth/server";
import { signOut } from "../login/actions";

export const metadata = { title: "Support Ops Dashboard" };

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/tickets", label: "Tickets" },
  { href: "/dashboard/escalations", label: "Escalations" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Dashboard">
            <span className="mr-3 font-semibold">Support Ops</span>
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="rounded-md px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <Suspense fallback={<span className="text-xs text-zinc-400">…</span>}>
            <UserBadge />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

async function UserBadge() {
  const viewer = await getViewer();
  if (!viewer) return null;
  return (
    <div className="flex items-center gap-3 text-xs">
      {viewer.isDemo ? (
        <span className="rounded-full bg-amber-100 px-2 py-1 font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
          Demo · read-only
        </span>
      ) : (
        <span className="text-zinc-500">{viewer.email}</span>
      )}
      <form action={signOut}>
        <button className="rounded-md border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
          Sign out
        </button>
      </form>
    </div>
  );
}
