/**
 * Runs the eval suite against ONE model (no fallback, so the model is measured alone), scores
 * every case, judges the replies, and appends results to
 *   evals/results/<PROMPT_VERSION>/<provider>__<model>.jsonl
 *
 * Resumable: cases already scored for this prompt version + model are skipped, so free-tier
 * daily quotas can be spread over several runs/days. A daily quota hit stops the run cleanly.
 *
 * Usage: npm run eval -- --model groq:openai/gpt-oss-120b [--only id1,id2] [--pace 40000] [--force]
 */
import "../scripts/load-env.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MemoryRepo } from "../src/lib/agent/memory-repo.ts";
import { runAgent, type AgentResult } from "../src/lib/agent/orchestrator.ts";
import { PROMPT_VERSION } from "../src/lib/agent/prompts.ts";
import { buildChain, type LLMConfig } from "../src/lib/llm/index.ts";
import { estimateCostUsd } from "../src/lib/llm/pricing.ts";
import { ModelRouter, RouterExhaustedError, retryHintMs } from "../src/lib/llm/router.ts";
import { loadTenantFolders } from "../src/lib/tenants/load.ts";
import { CASES, type EvalCase } from "./cases.ts";
import { JUDGE_VERSION, judge } from "./judge.ts";
import { compact, expand, type CompactResult } from "./compact.ts";
import { casePassed, score, type Check } from "./score.ts";

export interface EvalRecord {
  caseId: string;
  category: EvalCase["category"];
  model: string;
  promptVersion: string;
  judgeVersion: string;
  at: string;
  /** "infra" = provider unavailable / rate-limited: excluded from quality, counted as availability. */
  status: "scored" | "infra";
  passed: boolean;
  checks: Check[];
  judge: Record<string, unknown> | null;
  outcome: string;
  latencyMs: number;
  /** Sum of model-call latencies (excludes rate-limit waits and tool time). */
  modelLatencyMs: number;
  usage: AgentResult["usage"];
  costUsd: number;
  reply: string | null;
  escalationReasons: string[];
  actions: string[];
  /** Agent-side errors (validation failures, tool errors, provider errors), clipped. */
  errors: string[];
  /** Re-scorable copy of the run (report.ts re-scores with the current scorer). */
  result: CompactResult;
}

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    only: { type: "string" },
    pace: { type: "string" },
    force: { type: "boolean", default: false },
    /** Only (re-)judge stored records whose judge call failed or is missing; no agent runs. */
    "judge-only": { type: "boolean", default: false },
    judge: {
      type: "string",
      default: process.env.EVAL_JUDGE ?? "gemini:gemini-3.6-flash,gemini:gemini-3.8-flash",
    },
  },
});
if (!values.model) {
  console.error("Usage: npm run eval -- --model <provider:model>  (e.g. groq:openai/gpt-oss-120b)");
  process.exit(1);
}

const env = process.env as unknown as LLMConfig;
const RATE_WAIT_MS = 60_000; // evals may wait out per-minute limits; production can't
const chainFor = (spec: string) => buildChain({ ...env, LLM_PROVIDER: "gemini", LLM_CHAIN: spec });
const candidate = chainFor(values.model);
if (!candidate.length) {
  console.error(`No API key for ${values.model}`);
  process.exit(1);
}
/**
 * Evals measure quality, not free-tier throughput: keep waiting out *per-minute* limits (up to 6
 * times per call). Daily quotas still fail immediately and stop the run.
 */
function patient(inner: ModelRouter): Pick<ModelRouter, "generate"> {
  return {
    async generate(req) {
      for (let i = 0; ; i++) {
        try {
          return await inner.generate({ ...req, deadline: undefined });
        } catch (error) {
          if (!(error instanceof RouterExhaustedError) || i >= 6) throw error;
          const hints = error.attempts
            .filter((a) => !a.skipped && a.error?.kind === "rate_limit")
            .map((a) => retryHintMs(a.error?.message ?? "") ?? 20_000);
          if (!hints.length) throw error;
          await new Promise((r) => setTimeout(r, Math.min(Math.max(...hints) + 1_000, 65_000)));
        }
      }
    },
  };
}
const router = patient(new ModelRouter(candidate, Date.now, RATE_WAIT_MS));
const judgeRouter = patient(new ModelRouter(chainFor(values.judge!), Date.now, RATE_WAIT_MS));

const slug = values.model.replace(/[/:]/g, "__");
const dir = join(import.meta.dirname, "results", PROMPT_VERSION);
mkdirSync(dir, { recursive: true });
const file = join(dir, `${slug}.jsonl`);
const done = new Set(
  existsSync(file) && !values.force
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as EvalRecord)
        .filter((r) => r.status === "scored")
        .map((r) => r.caseId)
    : [],
);

const readRecords = (): EvalRecord[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as EvalRecord)
    : [];

if (values["judge-only"]) {
  const latest = new Map(readRecords().map((r) => [r.caseId, r]));
  const pending = [...latest.values()].filter(
    (r) => r.status === "scored" && r.reply && (!r.judge || "error" in r.judge),
  );
  console.log(`${values.model}: judging ${pending.length} stored replies`);
  for (const rec of pending) {
    const c = CASES.find((x) => x.id === rec.caseId);
    if (!c) continue;
    const judged = await judge(judgeRouter, c, expand(rec.result, rec.promptVersion));
    appendFileSync(
      file,
      JSON.stringify({ ...rec, judge: judged, judgeVersion: JUDGE_VERSION }) + "\n",
    );
    console.log(`${"error" in judged ? "⚠" : "✓"} ${rec.caseId}`);
    if ("error" in judged && /quota|exhausted/i.test(judged.error)) break;
  }
  process.exit(0);
}

const only = values.only?.split(",");
const todo = CASES.filter((c) => (!only || only.includes(c.id)) && !done.has(c.id));
const pace = Number(values.pace ?? (values.model.startsWith("groq:") ? 40_000 : 15_000));
const tenants = loadTenantFolders(join(import.meta.dirname, "..", "tenants"));
console.log(
  `${values.model} · ${PROMPT_VERSION} · ${todo.length} to run (${done.size} done) · pace ${pace} ms`,
);

/** Errors that say nothing about the model's quality: the provider was unavailable. */
function infraKinds(r: AgentResult): string[] {
  const kinds: string[] = [];
  for (const t of r.trace) {
    if (t.type !== "error") continue;
    const attempts = (t.output as { attempts?: { error?: { kind?: string } }[] } | undefined)
      ?.attempts;
    for (const a of attempts ?? []) if (a.error?.kind) kinds.push(a.error.kind);
  }
  return kinds.filter((k) =>
    ["rate_limit", "quota_exhausted", "unavailable", "timeout"].includes(k),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
for (const c of todo) {
  if (n++) await sleep(pace);
  const repo = new MemoryRepo(tenants); // fresh state: one case's refund can't affect the next
  const tenantId = MemoryRepo.tenantId(c.tenant);
  const verified = c.from !== null && c.verified !== false;
  const customer = verified && c.from ? repo.findCustomerByEmail(tenantId, c.from) : null;
  const r = await runAgent(
    {
      tenantId,
      ticketId: `eval-${c.id}`,
      channel: c.channel ?? "email",
      conversation: c.messages.map((body, i) => ({
        author: i % 2 === 0 ? "customer" : "ai",
        body,
      })),
      customerId: customer?.id ?? null,
      customerEmail: c.from,
      senderVerified: !!customer,
      aiReplyCount: Math.floor(c.messages.length / 2),
    },
    // Generous budget: free-tier per-minute limits mean waiting, and a wait isn't a wrong answer.
    // Latency is measured as model time only (modelLatencyMs) so waits don't distort it.
    {
      router,
      classifierRouter: router,
      repo,
      limits: { budgetMs: 180_000, callTimeoutMs: 60_000 },
    },
  );
  const infra = r.escalation?.reasons.includes("agent_error") ? infraKinds(r) : [];
  const checks = score(c, r);
  const judged = infra.length ? null : await judge(judgeRouter, c, r);
  const rec: EvalRecord = {
    caseId: c.id,
    category: c.category,
    model: values.model,
    promptVersion: PROMPT_VERSION,
    judgeVersion: JUDGE_VERSION,
    at: new Date().toISOString(),
    status: infra.length ? "infra" : "scored",
    passed: !infra.length && casePassed(checks),
    checks,
    judge: judged as Record<string, unknown> | null,
    outcome: r.outcome,
    latencyMs: r.latencyMs,
    modelLatencyMs: r.trace
      .filter((t) => t.type === "model_call")
      .reduce((ms, t) => ms + (t.latencyMs ?? 0), 0),
    usage: r.usage,
    costUsd: estimateCostUsd(r.models, r.usage),
    reply: r.reply ?? r.escalation?.suggestedReply ?? null,
    escalationReasons: r.escalation?.reasons ?? [],
    actions: r.actions.map((a) => `${a.type}:${a.orderNumber}:${a.status}`),
    errors: r.trace
      .filter((t) => t.type === "error")
      .map((t) => `${t.name}: ${JSON.stringify(t.output).slice(0, 1500)}`),
    result: compact(r),
  };
  appendFileSync(file, JSON.stringify(rec) + "\n");
  const failed = checks.filter((x) => !x.pass).map((x) => x.name);
  console.log(
    `${rec.status === "infra" ? "⚠ infra" : rec.passed ? "✓" : "✗"} ${c.id.padEnd(30)} ${r.outcome.padEnd(17)} ${String(r.latencyMs).padStart(6)} ms ${
      infra.length ? infra.join(",") : failed.join(", ")
    }`,
  );
  if (infra.includes("quota_exhausted")) {
    console.log("Daily quota exhausted for this model: stopping. Re-run later to resume.");
    break;
  }
}
