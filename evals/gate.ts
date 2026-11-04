/**
 * CI eval gate. Fails the build when:
 *  - src/lib/agent/prompts.ts changed but evals weren't re-run (prompt hash mismatch), or the
 *    current PROMPT_VERSION has no results at all;
 *  - a gate model (the production chain, evals/thresholds.json) falls below the pass rate, has
 *    any policy (safety) failure, has too few scored cases, or regressed vs the previous version.
 * Live model calls never run in CI (free-tier quotas, no secrets in CI): results are produced
 * locally with `npm run eval` and committed, and CI verifies them.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROMPT_VERSION } from "../src/lib/agent/prompts.ts";
import { promptHash, type ModelSummary } from "./report.ts";

interface Summary {
  promptVersion: string;
  promptHash: string;
  totalCases: number;
  models: ModelSummary[];
}
const T = JSON.parse(readFileSync(join(import.meta.dirname, "thresholds.json"), "utf8")) as {
  gateModels: string[];
  minPassRate: number;
  maxPolicyFailures: number;
  minScoredFraction: number;
  maxRegression: number;
};
const resultsDir = join(import.meta.dirname, "results");
const load = (v: string): Summary | null => {
  const f = join(resultsDir, v, "summary.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Summary) : null;
};
const semver = (v: string) => v.replace(/^\D+/, "").split(".").map(Number);
const older = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

const errors: string[] = [];
const current = load(PROMPT_VERSION);
if (!current) {
  errors.push(
    `no eval results for ${PROMPT_VERSION}: run \`npm run eval -- --model <m>\` and \`npm run eval:report\`, then commit evals/results/`,
  );
} else {
  if (current.promptHash !== promptHash())
    errors.push(
      `prompts.ts changed since evals ran for ${PROMPT_VERSION}: bump PROMPT_VERSION and re-run the evals`,
    );
  const previousVersion = existsSync(resultsDir)
    ? readdirSync(resultsDir)
        .filter((v) => v !== PROMPT_VERSION && older(v, PROMPT_VERSION) && load(v))
        .sort((a, b) => (older(a, b) ? 1 : -1))[0]
    : undefined;
  const previous = previousVersion ? load(previousVersion) : null;
  for (const model of T.gateModels) {
    const s = current.models.find((m) => m.model === model);
    if (!s) {
      errors.push(`${model}: no results for ${PROMPT_VERSION}`);
      continue;
    }
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    if (s.scored < T.minScoredFraction * current.totalCases)
      errors.push(`${model}: only ${s.scored}/${current.totalCases} cases scored`);
    if (s.passRate < T.minPassRate)
      errors.push(`${model}: pass rate ${pct(s.passRate)} < ${pct(T.minPassRate)}`);
    if (s.policyFailures > T.maxPolicyFailures)
      errors.push(`${model}: ${s.policyFailures} policy (safety) check failures`);
    const before = previous?.models.find((m) => m.model === model);
    if (before && before.passRate - s.passRate > T.maxRegression)
      errors.push(
        `${model}: pass rate regressed ${pct(before.passRate)} → ${pct(s.passRate)} vs ${previousVersion}`,
      );
    console.log(
      `${model}: ${pct(s.passRate)} pass, ${s.policyFailures} policy failures, ${s.scored}/${current.totalCases} scored`,
    );
  }
}
if (errors.length) {
  console.error(`✗ eval gate failed:\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}
console.log(`✓ eval gate passed for ${PROMPT_VERSION}`);
