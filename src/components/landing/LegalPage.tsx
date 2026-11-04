import Link from "next/link";
import type { ReactNode } from "react";

/** Shared shell for the privacy and terms pages: readable width, plain typography. */
export function LegalPage(props: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← Support Ops Agent
      </Link>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">{props.title}</h1>
      <p className="mt-1 text-sm text-zinc-500">Last updated {props.updated}</p>
      <div className="mt-8 space-y-6 text-sm leading-6 text-zinc-700 dark:text-zinc-300 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-zinc-900 dark:[&_h2]:text-zinc-100 [&_li]:ml-5 [&_li]:list-disc">
        {props.children}
      </div>
    </main>
  );
}
