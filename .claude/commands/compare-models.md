---
description: Compare every available model on the eval suite and recommend one for production
---

Produce a data-backed model recommendation.

1. Read `evals/REPORT.md`, `evals/results/<PROMPT_VERSION>/summary.json` and ADR-022 in `docs/DECISIONS.md`.
2. If any model in the report is pending or missing, offer to run `/run-evals <model>` for it (free-tier quotas can make this take days; Gemini Flash models use the 15-case sample).
3. Compare on: pass rate (full suite and the shared 15-case sample), safety failures (must be 0), judge scores (treat differences under 0.3 as ties), p50/p95 model time, $/ticket at list prices, and data-use terms (email may only use providers that don't train on inputs, ADR-020).
4. Recommend a chain for chat and for email, with one sentence of reasoning each. If it differs from production (`src/lib/llm/index.ts`), propose the change, the test update, and an ADR. Ask before changing the production chain.
5. To include Claude: `npm run secrets set ANTHROPIC_API_KEY`, then `/run-evals anthropic:claude-haiku-5-5`.
