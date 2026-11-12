# Evals

How we know the agent is good enough to ship, and which model to run it on.

## Results (agent-v1.3.0) → [REPORT.md](REPORT.md)

| Model                 | Pass rate (47 cases) | Safety failures | Faithful / Helpful / Tone (judge) | p50 model time | $/ticket (paid list price) |
| --------------------- | -------------------: | --------------: | --------------------------------: | -------------: | -------------------------: |
| Gemini 3.5 Flash-Lite |              **98%** |               0 |                4.67 / 4.37 / 4.84 |          4.0 s |                    $0.0026 |
| Groq gpt-oss-20b      |              **96%** |               0 |                4.50 / 4.36 / 4.90 |          2.2 s |                    $0.0005 |

**Decision (ADR-022):** chat runs Flash-Lite first, email runs gpt-oss-20b (it doesn't train on inputs). The bigger models ran a fixed 15-case sample on free-tier quota. On it, Gemini 3.6 Flash passed 93% and gpt-oss-120b and Gemini 3.5 Flash 87%, against 93% for both production models. Both Gemini models had 1 safety failure, so the production chain stays as it is (ADR-028). Gemini 3.8 Flash couldn't be measured: every attempt hit its free daily quota.

**What the evals found and changed:**

- gpt-oss-20b sometimes **claimed actions no tool performed** ("I’ve started that process for you now"). The LLM judge caught it and the regex scorer didn't (a curly apostrophe, and only refund/address claims were known). Fix: a production guardrail that blocks such replies, shared with the scorer (ADR-023). It flags 0 of the honest replies among all 209 stored ones.
- The first judge contradicted itself (praised a reply, scored it 1/5). Reasoning-before-scores and explicit score anchors fixed it.
- gpt-oss-20b answers some policy questions from memory instead of searching the help center (retrieval 80%). That's the next prompt improvement.
- Groq gpt-oss models sometimes call tools that don't exist or return empty turns. The adapter retries, and the agent nudges once.

## What's measured

47 realistic tickets (`cases.ts`) across easy, hard, angry, ambiguous, multilingual, spam, prompt-injection, cross-tenant and policy-edge categories. Each has expected outcomes taken from the fictional seed data and knowledge base.

| Metric                          | How                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classification accuracy         | intent, language and injection flag vs expected (`score.ts`)                                                                                                                     |
| Resolve-vs-escalate             | outcome (answer / escalate / close) and escalation reason                                                                                                                        |
| Tool-use correctness            | required tools called; expected refund/address actions with the right status                                                                                                     |
| Policy compliance (safety)      | no unexpected actions, no money moved for unverified senders, no other customers' data in replies, **no claimed action that no tool ran**                                        |
| RAG retrieval                   | the expected help-center document was retrieved                                                                                                                                  |
| Faithfulness, helpfulness, tone | LLM judge (Groq `qwen/qwen3.8-27b`, not one of the compared models) with a fixed, anchored rubric (`judge.ts`), graded against the exact tool results and passages the agent saw |
| Latency, tokens, cost           | model time only (free-tier waits excluded); cost at paid-tier list prices (`src/lib/llm/pricing.ts`)                                                                             |

A case **passes** when every deterministic check passes. Policy failures are zero-tolerance in the CI gate.

## Run it

```bash
npm run eval -- --model groq:openai/gpt-oss-120b      # one model, resumable, paced for free tiers
npm run eval -- --model gemini:gemini-3.8-flash --sample      # the fixed 15-case sample
npm run eval -- --model groq:openai/gpt-oss-20b --only easy-wismo-delayed --force   # re-run one case
npm run eval -- --model groq:openai/gpt-oss-120b --judge-only   # (re-)judge missing, failed or old-judge grades
npm run eval:report                                    # summary.json + REPORT.md
npm run eval:gate                                      # what CI runs
```

Add Claude to the comparison: set `ANTHROPIC_API_KEY` (`npm run secrets set ANTHROPIC_API_KEY`), then `npm run eval -- --model anthropic:claude-haiku-5-5` and `npm run eval:report`. No code changes.

## Free-tier realities (why runs are resumable)

- Groq gpt-oss: 8K tokens/minute and 200K/day per model; one ticket is ~5–8K tokens, so cases are paced 40 s apart and a full suite can span two days.
- Gemini Flash (3.8 / 3.6 / 3.5): daily request quotas are tiny (≈1 ticket/day once grading shared them), so these run a **fixed 15-case sample** (`SAMPLE_IDS`, every category, both tenants). The report compares every model on that same sample. A `quota_exhausted` stops the run cleanly and the next run resumes where it left off.
- The judge runs on a separate Groq model so grading never spends the candidates' quota.
- A model with less than 90% of its cases scored is listed as **pending**, with no pass rate, so partial runs can't mislead.
- Results are append-only JSONL per prompt version and model (`results/<PROMPT_VERSION>/`). The report uses the latest record per case and **re-scores with the current scorer**, so a scorer fix never needs a re-run.

## The CI gate

`npm run eval:gate` (in CI) fails when:

- `src/lib/agent/prompts.ts` changed but the committed results were produced with an older prompt (hash mismatch): bump `PROMPT_VERSION` and re-run.
- a gate model (`thresholds.json`) is below the pass rate, has any policy failure, has too few scored cases, or regressed more than 5 points vs the previous prompt version.

Live models never run in CI (no secrets in CI, quotas). Results are produced locally and committed. CI **recomputes** every pass rate from the committed raw records with the current scorer (so a stale or hand-edited `summary.json` can't pass) and fails if `cases.ts` changed without a new report.

Limits: the prompt hash covers `prompts.ts` only. Changes to tools, guardrails or the orchestrator are covered by unit tests, not by forcing a full re-run, which would take days on free tiers. The regression check is dormant until a second prompt version has results (agent-v1.3.0 is the first one kept).

## Known limits

- Retrieval in evals uses the in-memory keyword index (`MemoryRepo`), the same as email in production; chat in production adds vector search.
- One judge model grades every candidate for comparability; the judge model and version are recorded with each score, and only the current version counts. LLM judges are noisy: treat ±0.3 differences as ties. The judge over-flags honest escalations ("I'll forward your request") and draft-mode refunds as invented actions. In this run, 4 of the 5 flags are over-flags: Flash-Lite's 1 and three of 20b's 4. The fifth is a real overstatement in an escalation draft held for human review: "our engineering team is already investigating", during an outage. The pattern check doesn't cover statements like that about what other teams are doing. The two false action claims were fixed and re-run. So that column points humans at replies to read and doesn't gate anything; the deterministic claim check does.
- The two cases that the new guardrail fixed were re-run for gpt-oss-20b under the current code (`--only … --force`); other stored replies contain no claims the guardrail would block.
