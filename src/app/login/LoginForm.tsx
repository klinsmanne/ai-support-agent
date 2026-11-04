"use client";

import { useActionState } from "react";
import { sendMagicLink, viewDemo } from "./actions";

export function LoginForm({ error }: { error?: string }) {
  const [state, action, pending] = useActionState(sendMagicLink, { message: "" });
  return (
    <div className="w-full max-w-sm space-y-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div>
        <h1 className="text-xl font-semibold">Support operations dashboard</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Tickets, agent traces, escalations, settings and metrics.
        </p>
      </div>

      <form action={viewDemo}>
        <button className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900">
          View demo dashboard (read-only)
        </button>
        <p className="mt-2 text-xs text-zinc-500">No sign-up needed. Fictional demo data only.</p>
      </form>

      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" /> Team members{" "}
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      </div>

      <form action={action} className="space-y-3">
        <label className="block text-sm">
          Work email
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
          />
        </label>
        <button
          disabled={pending}
          className="w-full rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
        >
          {pending ? "Sending…" : "Email me a sign-in link"}
        </button>
        {state.message && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400" role="status">
            {state.message}
          </p>
        )}
        {error === "link" && (
          <p className="text-sm text-red-600">
            That sign-in link is invalid or expired. Request a new one.
          </p>
        )}
        {error === "demo" && (
          <p className="text-sm text-red-600">The demo account isn&apos;t available right now.</p>
        )}
      </form>
    </div>
  );
}
