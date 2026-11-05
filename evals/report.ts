/**
 * Aggregates evals/results/<PROMPT_VERSION>/*.jsonl into summary.json (read by the CI gate) and
 * REPORT.md (model comparison table). Uses the latest record per case per model.
 * Usage: npm run eval:report
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROMPT_VERSION } from "../src/lib/agent/prompts.ts";
import { CASES, SAMPLE_IDS, SAMPLED_MODELS, type Category } from "./cases.ts";
import { JUDGE_MODEL, JUDGE_VERSION } from "./judge.ts";
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
  /** True when the model runs only the fixed sample (SAMPLE_IDS), not the full suite. */
  sampled: boolean;
  /** Cases this model is expected to run: the sample or the full suite. */
  target: number;
  /** Enough cases scored (≥ COMPLETE_FRACTION of target) for its numbers to be reported. */
  complete: boolean;
  /** Pass rate on the fixed sample: the like-for-like comparison across all models. */
  sample: { pass: number; total: number; policyFailures: number };
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

/** Below this share of its cases, a model is listed as pending rather than given a pass rate. */
export const COMPLETE_FRACTION = 0.9;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * @param fallbackModel model id to use when the file has no records (derived from its name).
 */
/**
 * Latest record per case, re-scored with the current scorer so results stay comparable after
 * scorer fixes. A sampled model is judged only on the sample, even if older runs scored others.
 * Shared by the summary, the CI gate and the per-case export the Python analysis reads.
 */
export function rescore(records: EvalRecord[], fallbackModel = "?"): EvalRecord[] {
  const model = records[0]?.model ?? fallbackModel;
  const sampled = SAMPLED_MODELS.includes(model);
  const latest = new Map<string, EvalRecord>();
  for (const r of records) latest.set(r.caseId, r); // files are append-only: last one wins
  return [...latest.values()]
    .filter((r) => CASES.some((c) => c.id === r.caseId))
    .filter((r) => !sampled || SAMPLE_IDS.includes(r.caseId))
    .map((r) => {
      if (r.status !== "scored" || !r.result) return r;
      const checks = score(
        CASES.find((c) => c.id === r.caseId)!,
        expand(r.result, r.promptVersion),
      );
      return { ...r, checks, passed: casePassed(checks) };
    });
}

export function summarize(records: EvalRecord[], fallbackModel = "?"): ModelSummary {
  const model = records[0]?.model ?? fallbackModel;
  const sampled = SAMPLED_MODELS.includes(model);
  const target = sampled ? SAMPLE_IDS.length : CASES.length;
  const all = rescore(records, fallbackModel);
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
  // Only grades from the current judge version and model count: mixing judges isn't comparable.
  const judged = scored
    .filter((r) => r.judgeVersion === JUDGE_VERSION && r.judge?.judgeModel === JUDGE_MODEL)
    .map((r) => r.judge)
    .filter((j): j is Record<string, number | boolean> => !!j && !("error" in j));
  const inSample = scored.filter((r) => SAMPLE_IDS.includes(r.caseId));
  return {
    model,
    cases: all.length,
    scored: scored.length,
    infra: all.length - scored.length,
    passRate: scored.length ? scored.filter((r) => r.passed).length / scored.length : 0,
    sampled,
    target,
    complete: scored.length >= COMPLETE_FRACTION * target,
    sample: {
      pass: inSample.filter((r) => r.passed).length,
      total: inSample.length,
      policyFailures: inSample.reduce(
        (n, r) => n + r.checks.filter((c) => c.metric === "policy" && !c.pass).length,
        0,
      ),
    },
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

/**
 * Summaries for every model in a results folder, recomputed from the raw records (the CI gate uses
 * this too, so a stale or hand-edited summary.json can't pass). Full-suite models sort before
 * sampled ones: a pass rate on 15 cases isn't comparable with one on 47.
 */
export function loadSummaries(resultsDir: string): ModelSummary[] {
  return readdirSync(resultsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) =>
      summarize(
        readFileSync(join(resultsDir, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as EvalRecord),
        f
          .replace(/\.jsonl$/, "")
          .replace("__", ":")
          .replace("__", "/"),
      ),
    )
    .sort(
      (a, b) =>
        Number(a.sampled) - Number(b.sampled) ||
        b.passRate - a.passRate ||
        a.policyFailures - b.policyFailures,
    );
}

function main() {
  if (!existsSync(dir)) {
    console.error(
      `No results for ${PROMPT_VERSION}. Run: npm run eval -- --model <provider:model>`,
    );
    process.exit(1);
  }
  const models = loadSummaries(dir);

  // Per-case export (current scorer, current judge) for the Python/SQL analysis in analysis/.
  const rows = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      rescore(
        readFileSync(join(dir, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as EvalRecord),
        f
          .replace(/\.jsonl$/, "")
          .replace("__", ":")
          .replace("__", "/"),
      ).map((r) => ({
        model: r.model,
        caseId: r.caseId,
        category: r.category,
        status: r.status,
        passed: r.status === "scored" && r.passed,
        failedChecks: r.checks.filter((c) => !c.pass).map((c) => c.name),
        policyFailures: r.checks.filter((c) => c.metric === "policy" && !c.pass).length,
        outcome: r.outcome,
        modelLatencyMs: r.modelLatencyMs,
        costUsd: r.costUsd,
        tokens: r.usage.inputTokens + r.usage.outputTokens,
        judgeFaithfulness:
          r.judgeVersion === JUDGE_VERSION && r.judge && !("error" in r.judge)
            ? Number(r.judge.faithfulness)
            : null,
      })),
    );
  writeFileSync(join(dir, "cases.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

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

  // Category columns come from a full-suite model (a sampled one lacks some categories).
  const done = models.filter((s) => s.complete);
  const pending = models.filter((s) => !s.complete);
  const fullCats = (done.find((s) => !s.sampled) ?? done[0])?.categories ?? {};
  // Judge means over fewer than 5 judged replies aren't meaningful.
  const j = (v: number, s: ModelSummary) =>
    s.judge.judged >= 5 ? `${v.toFixed(2)} (n=${s.judge.judged})` : "—";
  const m = (s: ModelSummary, k: Check["metric"]) =>
    s.metrics[k] ? pct(s.metrics[k].pass / s.metrics[k].total) : "—";
  const lines = [
    `# Eval results — ${PROMPT_VERSION}`,
    "",
    `${CASES.length} cases · deterministic checks + LLM judge (${JUDGE_VERSION}) · generated by \`npm run eval:report\`. Latency is model time only (excludes free-tier rate-limit waits). Cost is at paid-tier list prices (the deployment itself runs on free tiers).`,
    "",
    "| Model | Scored | Pass rate | Outcome | Classif. | Tool use | Policy fails | Reply | Retrieval | Faithful | Helpful | Tone | Invented actions | p50 / p95 | Tokens | $/ticket |",
    "| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
    ...done.map(
      (s) =>
        `| ${s.model}${s.sampled ? " *(sample)*" : ""} | ${s.scored}/${s.target}${s.infra ? ` (+${s.infra} infra)` : ""} | **${pct(s.passRate)}** | ${m(s, "outcome")} | ${m(s, "classification")} | ${m(s, "tool_use")} | ${s.policyFailures} | ${m(s, "reply")} | ${m(s, "retrieval")} | ${j(s.judge.faithfulness, s)} | ${j(s.judge.helpfulness, s)} | ${j(s.judge.tone, s)} | ${s.judge.judged ? s.judge.unperformedClaims : "—"} | ${(s.latency.p50 / 1000).toFixed(1)} s / ${(s.latency.p95 / 1000).toFixed(1)} s | ${Math.round(s.tokensPerTicket)} | $${s.costPerTicketUsd.toFixed(4)} |`,
    ),
    "",
    ...(pending.length
      ? [
          "**Pending (free-tier daily quota):** " +
            pending
              .map((s) => `${s.model}${s.sampled ? " *(sample)*" : ""} ${s.scored}/${s.target}`)
              .join(" · ") +
            ". They resume with \`npm run eval -- --model <m>\` (resumable) and are added here when complete; no numbers are shown until a model has scored 90% of its cases.",
          "",
        ]
      : []),
    "## Same 15-case sample, every model",
    "",
    `Models whose free tier can't fit the full suite (marked *sample*) ran only this fixed sample, which covers every category (\`SAMPLE_IDS\` in \`cases.ts\`). Full-suite models are shown on the same ${SAMPLE_IDS.length} cases for a like-for-like comparison.`,
    "",
    "| Model | Sample cases scored | Pass rate on sample | Policy fails on sample |",
    "| --- | --: | --: | --: |",
    ...[...done]
      .sort((a, b) => b.sample.pass / (b.sample.total || 1) - a.sample.pass / (a.sample.total || 1))
      .map(
        (s) =>
          `| ${s.model}${s.sampled ? " *(sample)*" : ""} | ${s.sample.total}/${SAMPLE_IDS.length} | ${s.sample.total ? `**${pct(s.sample.pass / s.sample.total)}**` : "—"} | ${s.sample.policyFailures} |`,
      ),
    "",
    "## Pass rate by category (full-suite models)",
    "",
    `| Model | ${(Object.keys(fullCats) as Category[]).join(" | ")} |`,
    `| --- |${Object.keys(fullCats)
      .map(() => " --: |")
      .join("")}`,
    ...done
      .filter((s) => !s.sampled)
      .map(
        (s) =>
          `| ${s.model} | ${(Object.keys(fullCats) as Category[])
            .map((k) =>
              s.categories[k] ? `${s.categories[k]!.pass}/${s.categories[k]!.total}` : "—",
            )
            .join(" | ")} |`,
      ),
    "",
  ];
  writeFileSync(join(import.meta.dirname, "REPORT.md"), lines.join("\n"));
  console.log(lines.slice(4, 8 + done.length).join("\n"));
}

if (process.argv[1]?.endsWith("report.ts")) main();
