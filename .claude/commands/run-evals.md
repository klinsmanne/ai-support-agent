---
description: Run the eval suite for one model (resumable, free-tier paced), then the report and the CI gate
argument-hint: "[provider:model] (default: the production models)"
---

Run the evaluation suite and report the results in plain language.

1. Model: use `$ARGUMENTS` if given (e.g. `groq:openai/gpt-oss-20b`), otherwise the gate models in `evals/thresholds.json`.
2. For each model run `npm run eval -- --model <model>` in the background. It is resumable, paced for free tiers, and stops cleanly on a daily quota. If it stops on quota, say when it resets (Gemini: midnight Pacific; Groq: rolling 24 h) and don't retry in a loop.
3. Then `npm run eval:report` and `npm run eval:gate`.
4. Summarize: pass rate, safety (policy) failures, judge scores, p50 latency, $/ticket, and every failing case with its failed check. Explain any failure in one sentence and suggest whether it's a prompt, policy, help-center or scorer issue.
5. Never weaken a case or the scorer to make a model pass. Never put API keys on the command line.
