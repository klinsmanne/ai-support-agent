/**
 * Aggregates evals/results/<PROMPT_VERSION>/*.jsonl into summary.json (read by the CI gate) and
 * REPORT.md (model comparison table). Uses the latest record per case per model.
 * Usage: npm run eval:report
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROMPT_VERSION } from "../src/lib/agent/prompts.ts";
import { CASES, type Category } from "./cases.ts";
import type { EvalRecord } from "./run.ts";
import { expand } from "./compact.ts";
import { casePassed, score, type Check } from "./score.ts";

const root = join(import.meta.dirname, "..");
const dir = join(import.meta.dirname, "results", PROMPT_VERSION);

/** Fingerprint of the prompts the results were produced with (CI fails if prompts change). */
export function promptHash(): string {
  return createHash("sha256")
    .update(readFileSync(join(root, "src/lib/agent/prompts.ts"), "utf8"))
    .digest("hex")
    .slice(0, 16);
}

export interface ModelSummary {
  model: string;
  cases: number;
  scored: number;
  infra: number;
  passRate: number;
  metrics: Record<Check["metric"], { pass: number; total: number }>;
  categories: Partial<Record<Category, { pass: number; total: number }>>;
  /** Failed policy checks (safety): must be 0 for a model to be eligible. */
  policyFailures: number;
  judge: {
    faithfulness: number;
    helpfulness: number;
    tone: number;
    unperformedClaims: number;
    judged: number;
  };
  latency: { p50: number; p95: number };
  tokensPerTicket: number;
  costPerTicketUsd: number;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(records: EvalRecord[]): ModelSummary {
  const latest = new Map<string, EvalRecord>();
  for (const r of records) latest.set(r.caseId, r); // files are append-only: last one wins
  // Re-score with the current scorer so results stay comparable after scorer fixes.
  const all = [...latest.values()]
    .filter((r) => CASES.some((c) => c.id === r.caseId))
    .map((r) => {
      if (r.status !== "scored" || !r.result) return r;
      const checks = score(
        CASES.find((c) => c.id === r.caseId)!,
        expand(r.result, r.promptVersion),
      );
      return { ...r, checks, passed: casePassed(checks) };
    });
  const scored = all.filter((r) => r.status === "scored");
  const metrics = {} as ModelSummary["metrics"];
  const categories: ModelSummary["categories"] = {};
  for (const r of scored) {
    for (const c of r.checks) {
      const m = (metrics[c.metric] ??= { pass: 0, total: 0 });
      m.total++;
      if (c.pass) m.pass++;
    }
    const cat = (categories[r.category] ??= { pass: 0, total: 0 });
    cat.total++;
    if (r.passed) cat.pass++;
  }
  const judged = scored
    .map((r) => r.judge)
    .filter((j): j is Record<string, number | boolean> => !!j && !("error" in j));
  return {
    model: all[0]?.model ?? "?",
    cases: all.length,
    scored: scored.length,
    infra: all.length - scored.length,
    passRate: scored.length ? scored.filter((r) => r.passed).length / scored.length : 0,
    metrics,
    categories,
    policyFailures: scored.reduce(
      (n, r) => n + r.checks.filter((c) => c.metric === "policy" && !c.pass).length,
      0,
    ),
    judge: {
      faithfulness: mean(judged.map((j) => Number(j.faithfulness))),
      helpfulness: mean(judged.map((j) => Number(j.helpfulness))),
      tone: mean(judged.map((j) => Number(j.tone))),
      unperformedClaims: judged.filter((j) => j.claims_unperformed_action === true).length,
      judged: judged.length,
    },
    latency: {
      p50: quantile(
        scored.map((r) => r.modelLatencyMs),
        0.5,
      ),
      p95: quantile(
        scored.map((r) => r.modelLatencyMs),
        0.95,
      ),
    },
    tokensPerTicket: mean(scored.map((r) => r.usage.inputTokens + r.usage.outputTokens)),
    costPerTicketUsd: mean(scored.map((r) => r.costUsd)),
  };
}

function main() {
  if (!existsSync(dir)) {
    console.error(
      `No results for ${PROMPT_VERSION}. Run: npm run eval -- --model <provider:model>`,
    );
    process.exit(1);
  }
  const models = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) =>
      summarize(
        readFileSync(join(dir, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as EvalRecord),
      ),
    )
    .sort((a, b) => b.passRate - a.passRate || a.policyFailures - b.policyFailures);

  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify(
      {
        promptVersion: PROMPT_VERSION,
        promptHash: promptHash(),
        totalCases: CASES.length,
        generatedAt: new Date().toISOString(),
        models,
      },
      null,
      2,
    ) + "\n",
  );

  // Judge means over fewer than 5 judged replies aren't meaningful.
  const j = (v: number, s: ModelSummary) =>
    s.judge.judged >= 5 ? `${v.toFixed(2)} (n=${s.judge.judged})` : "—";
  const m = (s: ModelSummary, k: Check["metric"]) =>
    s.metrics[k] ? pct(s.metrics[k].pass / s.metrics[k].total) : "—";
  const lines = [
    `# Eval results — ${PROMPT_VERSION}`,
    "",
    `${CASES.length} cases · deterministic checks + LLM judge · generated by \`npm run eval:report\`. Latency is model time only (excludes free-tier rate-limit waits). Cost is at paid-tier list prices (the deployment itself runs on free tiers).`,
    "",
    "| Model | Scored | Pass rate | Outcome | Classif. | Tool use | Policy fails | Reply | Retrieval | Faithful | Helpful | Tone | Invented actions | p50 / p95 | Tokens | $/ticket |",
    "| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
    ...models.map(
      (s) =>
        `| ${s.model} | ${s.scored}/${CASES.length}${s.infra ? ` (+${s.infra} infra)` : ""} | **${pct(s.passRate)}** | ${m(s, "outcome")} | ${m(s, "classification")} | ${m(s, "tool_use")} | ${s.policyFailures} | ${m(s, "reply")} | ${m(s, "retrieval")} | ${j(s.judge.faithfulness, s)} | ${j(s.judge.helpfulness, s)} | ${j(s.judge.tone, s)} | ${s.judge.judged ? s.judge.unperformedClaims : "—"} | ${(s.latency.p50 / 1000).toFixed(1)} s / ${(s.latency.p95 / 1000).toFixed(1)} s | ${Math.round(s.tokensPerTicket)} | $${s.costPerTicketUsd.toFixed(4)} |`,
    ),
    "",
    "## Pass rate by category",
    "",
    `| Model | ${(Object.keys(models[0]?.categories ?? {}) as Category[]).join(" | ")} |`,
    `| --- |${Object.keys(models[0]?.categories ?? {})
      .map(() => " --: |")
      .join("")}`,
    ...models.map(
      (s) =>
        `| ${s.model} | ${(Object.keys(models[0]?.categories ?? {}) as Category[])
          .map((k) =>
            s.categories[k] ? `${s.categories[k]!.pass}/${s.categories[k]!.total}` : "—",
          )
          .join(" | ")} |`,
    ),
    "",
  ];
  writeFileSync(join(import.meta.dirname, "REPORT.md"), lines.join("\n"));
  console.log(lines.slice(4, 6 + models.length).join("\n"));
}

if (process.argv[1]?.endsWith("report.ts")) main();
