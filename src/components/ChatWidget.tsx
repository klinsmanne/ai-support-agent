"use client";

import { useEffect, useRef, useState } from "react";

type Msg = { from: "you" | "agent" | "system"; text: string };

const TENANTS = [
  {
    slug: "harbor-pine",
    label: "Harbor & Pine (home goods)",
    sample: "Order 1042 · olivia.bennett@example.com",
  },
  {
    slug: "cadence-analytics",
    label: "Cadence Analytics (SaaS)",
    sample: "INV-2042 · tom.fischer@example.org",
  },
] as const;

/** Embeddable support chat. Talks only to our own /api/chat (same-origin), never to model APIs. */
export function ChatWidget() {
  const [tenant, setTenant] = useState<(typeof TENANTS)[number]["slug"]>("harbor-pine");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [showVerify, setShowVerify] = useState(false);
  const [order, setOrder] = useState("");
  const [email, setEmail] = useState("");
  const token = useRef<string | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function switchTenant(slug: (typeof TENANTS)[number]["slug"]) {
    setTenant(slug);
    setMessages([]);
    setVerified(false);
    token.current = undefined;
  }

  async function post(
    body: Record<string, unknown>,
  ): Promise<{ reply: string | null; verified: boolean } | null> {
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenant, sessionToken: token.current, ...body }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessages((m) => [
          ...m,
          { from: "system", text: json.error ?? "Something went wrong — please try again." },
        ]);
        return null;
      }
      token.current = json.sessionToken;
      setVerified(json.verified);
      return json;
    } catch {
      setMessages((m) => [...m, { from: "system", text: "Network error — please try again." }]);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { from: "you", text }]);
    const res = await post({ message: text });
    if (res)
      setMessages((m) => [
        ...m,
        { from: "agent", text: res.reply ?? "(This message was filtered and closed.)" },
      ]);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    const res = await post({ verify: { orderNumber: order, email } });
    if (res) {
      setMessages((m) => [...m, { from: "system", text: res.reply ?? "" }]);
      if (res.verified) setShowVerify(false);
    }
  }

  const current = TENANTS.find((t) => t.slug === tenant)!;
  return (
    <section
      aria-label="Support chat"
      className="flex h-[560px] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
    >
      <header className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div>
          <p className="text-sm font-semibold">AI support assistant</p>
          <p className="text-xs text-zinc-500">
            {verified ? "✓ Verified customer" : "Not verified · general questions only"}
          </p>
        </div>
        <select
          aria-label="Choose demo company"
          className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
          value={tenant}
          onChange={(e) => switchTenant(e.target.value as typeof tenant)}
        >
          {TENANTS.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.label}
            </option>
          ))}
        </select>
      </header>

      <div
        ref={listRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm"
        aria-live="polite"
      >
        {messages.length === 0 && (
          <div className="rounded-lg bg-zinc-100 p-3 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            Hi! I&apos;m an AI assistant for {current.label.split(" (")[0]}. Ask a question, or
            verify to discuss an order.
            <br />
            <span className="text-xs">Demo details: {current.sample}</span>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.from === "you" ? "flex justify-end" : "flex justify-start"}>
            <p
              className={
                m.from === "you"
                  ? "max-w-[85%] rounded-2xl rounded-br-sm bg-zinc-900 px-3 py-2 whitespace-pre-wrap text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : m.from === "agent"
                    ? "max-w-[85%] rounded-2xl rounded-bl-sm bg-zinc-100 px-3 py-2 whitespace-pre-wrap dark:bg-zinc-900"
                    : "w-full text-center text-xs text-zinc-500"
              }
            >
              {m.text}
            </p>
          </div>
        ))}
        {busy && (
          <p className="text-xs text-zinc-500">
            Assistant is working… (free-tier models can take a few seconds)
          </p>
        )}
      </div>

      {showVerify && !verified && (
        <form
          onSubmit={verify}
          className="space-y-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800"
        >
          <p className="text-xs text-zinc-500">
            Verify with an order number and the email used for that order.
          </p>
          <div className="flex gap-2">
            <input
              aria-label="Order number"
              required
              value={order}
              onChange={(e) => setOrder(e.target.value)}
              placeholder="1042"
              className="w-24 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
            />
            <input
              aria-label="Email"
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
            />
            <button
              disabled={busy}
              className="rounded-md bg-zinc-900 px-3 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Verify
            </button>
          </div>
        </form>
      )}

      <form
        onSubmit={send}
        className="flex gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800"
      >
        {!verified && (
          <button
            type="button"
            onClick={() => setShowVerify((v) => !v)}
            className="rounded-md border border-zinc-300 px-2 text-xs dark:border-zinc-700"
          >
            Verify
          </button>
        )}
        <input
          aria-label="Message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={2000}
          placeholder="Type your question…"
          className="flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
        />
        <button
          disabled={busy || !input.trim()}
          className="rounded-md bg-zinc-900 px-4 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Send
        </button>
      </form>
      <p className="px-4 pb-2 text-[10px] text-zinc-500">
        AI assistant · fictional demo data only · don&apos;t share real personal information
      </p>
    </section>
  );
}
