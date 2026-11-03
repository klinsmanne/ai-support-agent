/**
 * Estimated cost per model (USD per 1M tokens) for the business dashboard's "cost per ticket".
 * The deployment itself runs on free tiers ($0); these are *paid-tier list prices* used to show
 * what the same workload would cost at scale. Values are estimates and are re-verified against
 * provider pricing pages in the model-comparison milestone (see docs/research).
 */
const PRICES: Record<string, { input: number; output: number }> = {
  // Anthropic (from the Claude API reference, 2026-10)
  "anthropic:claude-opus-5-5": { input: 4, output: 20 },
  "anthropic:claude-sonnet-5-5": { input: 2, output: 10 },
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
