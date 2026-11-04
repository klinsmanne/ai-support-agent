import { ChatWidget } from "@/components/ChatWidget";

// Placeholder home page; the full landing page is milestone G.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-8 px-6 py-16">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          AI Customer Support Operations Agent
        </h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Try the live agent below — answers come from a multi-tenant agent with tools, RAG and
          guardrails.
        </p>
      </div>
      <ChatWidget />
    </main>
  );
}
