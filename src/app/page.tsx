import Link from "next/link";
import { Suspense } from "react";
import { ChatWidget } from "@/components/ChatWidget";
import { Architecture } from "@/components/landing/Architecture";
import { SCENARIOS } from "@/components/landing/scenarios";
import { TryButton } from "@/components/landing/TryButton";
import { getPublicStats } from "@/lib/landing/stats";

const SLUG = { "Harbor & Pine": "harbor-pine", "Cadence Analytics": "cadence-analytics" } as const;

function supportEmail(): string | null {
  return process.env.SUPPORT_EMAIL_ADDRESS ?? null;
}

function demoMailto(address: string, tenantTag?: string): string {
  const to = tenantTag ? address.replace("@", `+${tenantTag}@`) : address;
  const subject = "Question about my order";
  const body =
    "Hi,\n\nWhat's your return policy for sale items? And how long does shipping usually take?\n\nThanks!";
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default function Home() {
  const email = supportEmail();
  return (
    <div className="bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <p className="text-sm font-semibold">Support Ops Agent</p>
        <nav className="flex items-center gap-4 text-sm text-zinc-600 dark:text-zinc-400">
          <a href="#how" className="hidden hover:text-zinc-900 sm:inline dark:hover:text-white">
            How it works
          </a>
          <a href="#try" className="hidden hover:text-zinc-900 sm:inline dark:hover:text-white">
            Try it
          </a>
          <Link
            href="/login"
            className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Dashboard
          </Link>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
            AI customer support operations agent
          </p>
          <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Resolves routine support tickets in seconds. Hands the rest to your team, ready to send.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">
            Reads every email and chat message, looks up the order, applies the client&apos;s policy
            and replies, or escalates with a summary and a draft. Refund limits, tenant isolation
            and reply safety are enforced in code, not left to the model.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="#try"
              className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Try the live agent
            </a>
            {email && (
              <a
                href={demoMailto(email)}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
              >
                Send a demo email
              </a>
            )}
            <Link
              href="/login"
              className="rounded-lg px-4 py-2.5 text-sm font-medium text-zinc-700 hover:underline dark:text-zinc-300"
            >
              See the dashboard (read-only) →
            </Link>
          </div>
          <p className="mt-4 text-xs text-zinc-500">
            Two fictional companies · fictional customers and orders · runs entirely on free tiers
          </p>
        </section>

        {/* Problem */}
        <section className="border-y border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 className="text-2xl font-semibold tracking-tight">The problem</h2>
            <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-400">
              Harbor &amp; Pine, a home-goods store, gets about 6,500 tickets a month. Most are the
              same handful of questions, and customers wait hours for answers a lookup could give.
            </p>
            <dl className="mt-8 grid gap-4 sm:grid-cols-3">
              {[
                ["9.5 h", "median first response (30 h+ at weekends)"],
                ["$7.80", "cost per ticket, about 8 minutes of agent time"],
                ["75%", "of tickets are order status, returns, refunds or address changes"],
              ].map(([n, label]) => (
                <div key={n} className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
                  <dt className="text-3xl font-semibold">{n}</dt>
                  <dd className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{label}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs text-zinc-500">
              Targets agreed in discovery: ≥ 50% auto-resolved, first response under 2 minutes,
              under $3.50 per ticket, zero unauthorized refunds.
            </p>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="mx-auto max-w-6xl scroll-mt-6 px-4 py-14 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          <p className="mt-2 mb-8 max-w-2xl text-zinc-600 dark:text-zinc-400">
            Every message takes the same path. The model only ever <em>requests</em> an action; code
            checks it against the client&apos;s rules before anything happens.
          </p>
          <Architecture />
        </section>

        {/* Try it */}
        <section
          id="try"
          className="scroll-mt-6 border-y border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_28rem]">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Try it</h2>
              <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                Pick a scenario to fill in the chat. Order questions need a quick verification
                (order number + email), which the button fills in for you.
              </p>
              <ul className="mt-6 divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {SCENARIOS.map((s) => (
                  <li key={s.say} className="flex items-start justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">&ldquo;{s.say}&rdquo;</p>
                      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{s.expect}</p>
                      <p className="mt-1 text-[11px] text-zinc-500">
                        {s.tenant}
                        {s.verify ? ` · order ${s.verify.order} · ${s.verify.email}` : ""}
                      </p>
                    </div>
                    <TryButton tenant={SLUG[s.tenant]} text={s.say} verify={s.verify} />
                  </li>
                ))}
              </ul>
              {email && (
                <div className="mt-6 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
                  <h3 className="text-sm font-semibold">Or email the agent</h3>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                    Write to <span className="font-mono text-xs">{email}</span> from any address. A
                    reply arrives in the same thread, usually within a few minutes. Your address
                    isn&apos;t a known customer, so it answers general questions only, never account
                    changes.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <a
                      href={demoMailto(email)}
                      className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-zinc-900"
                    >
                      Send a demo email (Harbor &amp; Pine)
                    </a>
                    <a
                      href={demoMailto(email, "cadence")}
                      className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
                    >
                      Email Cadence Analytics instead
                    </a>
                  </div>
                </div>
              )}
            </div>
            <div id="chat" className="scroll-mt-4 lg:sticky lg:top-6 lg:self-start">
              <ChatWidget />
            </div>
          </div>
        </section>

        {/* Results */}
        <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">Live numbers</h2>
          <p className="mt-2 mb-8 max-w-2xl text-zinc-600 dark:text-zinc-400">
            Straight from the production database: every ticket this demo has handled in the last 30
            days, across both companies. Counts only, no content.
          </p>
          <Suspense fallback={<StatsGrid stats={null} />}>
            <LiveStats />
          </Suspense>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              [
                "Multi-tenant",
                "Each client has its own policies, knowledge base, brand voice and data, isolated by row-level security. A new client is a config file.",
              ],
              [
                "Human in the loop",
                "Rollout modes from shadow to draft-only to auto-send, a kill switch, and an approval queue where a person edits and sends.",
              ],
              [
                "Observable",
                "Every model call, tool call, retrieved passage and decision is traced, with latency, tokens and estimated cost per ticket.",
              ],
            ].map(([title, text]) => (
              <div
                key={title}
                className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Privacy */}
        <section className="border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
            <h2 className="text-sm font-semibold">Privacy note</h2>
            <p className="mt-2 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
              This is a demo. All customers and orders are fictional; please don&apos;t send real
              personal information. Messages are processed by AI models (Google Gemini, Groq) to
              write a reply and kept for a limited time (90 days by default) so the team can review
              them. Emails are never shown in the public demo dashboard; anonymous chat
              conversations can be. Replies always say they&apos;re from an AI and offer a human.{" "}
              <Link href="/privacy" className="underline">
                Full privacy policy
              </Link>
            </p>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-xs text-zinc-500 sm:px-6">
        <p>Portfolio project · fictional companies and data</p>
        <nav className="flex gap-4">
          <Link href="/privacy" className="hover:underline">
            Privacy
          </Link>
          <Link href="/terms" className="hover:underline">
            Terms
          </Link>
          <Link href="/login" className="hover:underline">
            Dashboard
          </Link>
        </nav>
      </footer>
    </div>
  );
}

async function LiveStats() {
  const stats = await getPublicStats();
  return <StatsGrid stats={stats} />;
}

function StatsGrid({ stats }: { stats: Awaited<ReturnType<typeof getPublicStats>> }) {
  const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const frt = (s: number | null | undefined) =>
    s == null ? "—" : s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`;
  const items: [string, string][] = [
    [stats ? String(stats.handled) : "—", "tickets handled"],
    [pct(stats?.autoResolutionRate), "resolved with no human touch"],
    [frt(stats?.medianFirstResponseSeconds), "median first response"],
    [stats ? String(stats.escalated) : "—", "escalated to a human"],
    [stats ? String(stats.injectionFlagged) : "—", "prompt-injection attempts caught"],
    [stats ? String(stats.spamClosed) : "—", "spam closed with no model cost"],
  ];
  return (
    <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
      {items.map(([n, label]) => (
        <div
          key={label}
          className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <dt className="text-2xl font-semibold tabular-nums">{n}</dt>
          <dd className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{label}</dd>
        </div>
      ))}
    </dl>
  );
}
