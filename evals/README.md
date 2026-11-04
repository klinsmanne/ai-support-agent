# Evals

How we know the agent is good enough to ship, and which model to run it on.

## What's measured

47 realistic tickets (`cases.ts`) across easy, hard, angry, ambiguous, multilingual, spam, prompt-injection, cross-tenant and policy-edge categories. Each has expected outcomes taken from the fictional seed data and knowledge base.

| Metric                          | How                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Classification accuracy         | intent, language and injection flag vs expected (`score.ts`)                                                                              |
| Resolve-vs-escalate             | outcome (answer / escalate / close) and escalation reason                                                                                 |
| Tool-use correctness            | required tools called; expected refund/address actions with the right status                                                              |
| Policy compliance (safety)      | no unexpected actions, no money moved for unverified senders, no other customers' data in replies, **no claimed action that no tool ran** |
| RAG retrieval                   | the expected help-center document was retrieved                                                                                           |
| Faithfulness, helpfulness, tone | LLM judge with a fixed rubric (`judge.ts`), graded against the exact tool results and passages the agent saw                              |
| Latency, tokens, cost           | model time only (free-tier waits excluded); cost at paid-tier list prices (`src/lib/llm/pricing.ts`)                                      |

A case **passes** when every deterministic check passes. Policy failures are zero-tolerance in the CI gate.

## Run it

```bash
npm run eval -- --model groq:openai/gpt-oss-120b      # one model, resumable, paced for free tiers
npm run eval -- --model gemini:gemini-3.8-flash --only easy-wismo-delayed,spam-prize
npm run eval -- --model groq:openai/gpt-oss-120b --judge-only   # judge replies whose judge call failed
npm run eval:report                                    # summary.json + REPORT.md
npm run eval:gate                                      # what CI runs
```

Add Claude to the comparison: set `ANTHROPIC_API_KEY` (`npm run secrets set ANTHROPIC_API_KEY`), then `npm run eval -- --model anthropic:claude-haiku-5-5` and `npm run eval:report`. No code changes.

## Free-tier realities (why runs are resumable)

- Groq gpt-oss: 8K tokens/minute and 200K/day per model; one ticket is ~5–8K tokens, so cases are paced 40 s apart and a full suite can span two days.
- Gemini Flash: daily request quotas are small and shared with the live demo; a `quota_exhausted` stops the run cleanly and the next run resumes where it left off.
- Results are append-only JSONL per prompt version and model (`results/<PROMPT_VERSION>/`). The report uses the latest record per case and **re-scores with the current scorer**, so a scorer fix never needs a re-run.

## The CI gate

`npm run eval:gate` (in CI) fails when:

- `src/lib/agent/prompts.ts` changed but the committed results were produced with an older prompt (hash mismatch): bump `PROMPT_VERSION` and re-run.
- a gate model (`thresholds.json`) is below the pass rate, has any policy failure, has too few scored cases, or regressed more than 5 points vs the previous prompt version.

Live models never run in CI (no secrets in CI, quotas). Results are produced locally and committed; CI verifies them.

## Known limits

- Retrieval in evals uses the in-memory keyword index (`MemoryRepo`), the same as email in production; chat in production adds vector search.
- One judge model grades every candidate for comparability; the judge model is recorded with each score. LLM judges are noisy: treat ±0.3 differences as ties.
