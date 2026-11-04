/**
 * Estimated cost per model (USD per 1M tokens) for the business dashboard's "cost per ticket".
 * The deployment itself runs on free tiers ($0); these are *paid-tier list prices* used to show
 * what the same workload would cost at scale. Values are list prices,
 * verified against the providers' pricing pages (see the date below).
 */
// Verified 2026-11-04 against aistudio.google.com/docs/pricing, console.groq.com/docs/models and
// platform.claude.com pricing. Gemini 3.8/3.6 Flash list prices double on 2027-01-01.
// gemini-3.5-flash is not on Google's price list, so it uses the flagged fallback below.
const PRICES: Record<string, { input: number; output: number }> = {
  "gemini:gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini:gemini-3.6-flash": { input: 0.75, output: 3.75 },
  "gemini:gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini:gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "groq:openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  "groq:openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
  "anthropic:claude-opus-5-5": { input: 4, output: 20 },
  "anthropic:claude-sonnet-5-5": { input: 2, output: 10 },
  // Haiku 5.5 is tiered at 100K-token prompts; support prompts are far below that.
  "anthropic:claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

/** Fallback for models without a verified price: flagged in the dashboard as an estimate. */
const DEFAULT_FLASH_CLASS = { input: 0.3, output: 2.5 };

export function pricePerMillion(model: string): {
  input: number;
  output: number;
  verified: boolean;
} {
  const p = PRICES[model];
  return p ? { ...p, verified: true } : { ...DEFAULT_FLASH_CLASS, verified: false };
}

/** Splits usage evenly across the models a run used (a run usually uses one or two). */
export function estimateCostUsd(
  models: string[],
  usage: { inputTokens: number; outputTokens: number },
): number {
  if (!models.length) return 0;
  const share = 1 / models.length;
  const total = models.reduce((sum, m) => {
    const p = pricePerMillion(m);
    return (
      sum + share * ((usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000)
    );
  }, 0);
  return Math.round(total * 1_000_000) / 1_000_000;
}
