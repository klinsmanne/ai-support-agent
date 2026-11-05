import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "2-minute demo · Support Ops Agent",
  description:
    "A 2-minute walkthrough of the live AI support agent: real conversations, the human handoff, traces, business metrics and eval results.",
};

/** The demo video, served from this site (public/demo) so it plays without third-party embeds. */
export default function Demo() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← Support Ops Agent
      </Link>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">2-minute demo</h1>
      <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-400">
        Real conversations from the live site, the human handoff, the trace behind every decision,
        business metrics, and how the models were chosen. Narrated, with captions.
      </p>
      <video
        className="mt-6 w-full rounded-xl border border-zinc-200 bg-black dark:border-zinc-800"
        controls
        preload="metadata"
        poster="/demo/poster.jpg"
        playsInline
      >
        <source src="/demo/demo.mp4" type="video/mp4" />
        Your browser can&apos;t play this video.{" "}
        <a href="/demo/demo.mp4" className="underline">
          Download it
        </a>{" "}
        instead.
      </video>
      <div className="mt-6 flex flex-wrap gap-3 text-sm">
        <Link
          href="/#try"
          className="rounded-lg bg-zinc-900 px-4 py-2.5 font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Try it yourself
        </Link>
        <Link
          href="/login"
          className="rounded-lg border border-zinc-300 px-4 py-2.5 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Open the read-only dashboard
        </Link>
      </div>
    </main>
  );
}
