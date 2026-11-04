/**
 * A compact, re-scorable copy of an agent run stored with each eval record: enough for the
 * deterministic scorer and the judge to run again later (after a scorer fix, or when the judge
 * was rate-limited), without re-running the agent. Tool outputs are clipped to keep files small.
 */
import type { AgentResult, TraceEvent } from "../src/lib/agent/orchestrator.ts";

export type CompactResult = Omit<AgentResult, "trace" | "citations" | "promptVersion"> & {
  promptVersion?: undefined;
  citations: { slug: string; title: string }[];
  trace: Pick<TraceEvent, "type" | "name" | "input" | "output">[];
};

const clip = (v: unknown) => {
  const s = JSON.stringify(v ?? null);
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : v;
};

export function compact(r: AgentResult): CompactResult {
  const { trace, citations, ...rest } = r;
  return {
    ...rest,
    promptVersion: undefined,
    citations: citations.map((c) => ({ slug: c.slug, title: c.title })),
    trace: trace
      .filter((t) => t.type === "tool_call" || t.type === "retrieval" || t.type === "error")
      .map((t) => ({ type: t.type, name: t.name, input: clip(t.input), output: clip(t.output) })),
  };
}

export function expand(c: CompactResult, promptVersion: string): AgentResult {
  return {
    ...c,
    promptVersion,
    citations: c.citations.map((h) => ({ ...h, content: "", score: 0, similarity: null })),
    trace: c.trace.map((t, seq) => ({ ...t, seq })),
  };
}
