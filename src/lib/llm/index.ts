import { AnthropicProvider } from "./anthropic.ts";
import { GeminiProvider } from "./gemini.ts";
import { GroqProvider } from "./groq.ts";
import { ModelRouter } from "./router.ts";
import type { LLMProvider } from "./types.ts";

export const DEFAULT_MODELS = {
  gemini: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"],
  groq: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
  anthropic: ["claude-opus-5-5"],
} as const;

export interface LLMConfig {
  LLM_PROVIDER: "gemini" | "groq" | "anthropic";
  LLM_MODEL?: string;
  /** Optional explicit chain, e.g. "gemini:gemini-3.6-flash,groq:openai/gpt-oss-120b" */
  LLM_CHAIN?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** "true" when the Gemini key is on a paid (billing-enabled) project: no training on prompts. */
  GEMINI_PAID_TIER?: string;
}

export interface ChainOptions {
  /** Only providers whose terms forbid training on request content (used for email). */
  noTraining?: boolean;
}

function makeProvider(id: string, model: string, cfg: LLMConfig): LLMProvider | null {
  if (id === "gemini" && cfg.GEMINI_API_KEY)
    return new GeminiProvider(model, cfg.GEMINI_API_KEY, cfg.GEMINI_PAID_TIER !== "true");
  if (id === "groq" && cfg.GROQ_API_KEY) return new GroqProvider(model, cfg.GROQ_API_KEY);
  if (id === "anthropic" && cfg.ANTHROPIC_API_KEY)
    return new AnthropicProvider(model, cfg.ANTHROPIC_API_KEY);
  return null; // provider without a key is simply left out of the chain
}

/**
 * Builds the fallback chain from configuration. Switching the primary model is one env var
 * (LLM_PROVIDER / LLM_MODEL); Groq is always appended as the cross-provider fallback.
 */
export function buildChain(cfg: LLMConfig, opts: ChainOptions = {}): LLMProvider[] {
  const specs: [string, string][] = cfg.LLM_CHAIN
    ? cfg.LLM_CHAIN.split(",").map((s) => {
        const [id, ...rest] = s.trim().split(":");
        return [id, rest.join(":")];
      })
    : cfg.LLM_PROVIDER === "gemini"
      ? [
          ...(cfg.LLM_MODEL ? [["gemini", cfg.LLM_MODEL] as [string, string]] : []),
          // Interleave providers: free quotas are per model and per provider, so after the two best
          // Gemini models a different provider is tried before older/smaller Gemini models.
          ["gemini", "gemini-3.8-flash"],
          ["gemini", "gemini-3.6-flash"],
          ["groq", "openai/gpt-oss-120b"],
          ["gemini", "gemini-3.5-flash"],
          ["gemini", "gemini-3.5-flash-lite"],
          ["groq", "openai/gpt-oss-20b"],
        ]
      : [
          ...(cfg.LLM_MODEL ? [[cfg.LLM_PROVIDER, cfg.LLM_MODEL] as [string, string]] : []),
          ...DEFAULT_MODELS[cfg.LLM_PROVIDER].map((m) => [cfg.LLM_PROVIDER, m] as [string, string]),
          ...(cfg.LLM_PROVIDER !== "groq"
            ? DEFAULT_MODELS.groq.map((m) => ["groq", m] as [string, string])
            : []),
          ...DEFAULT_MODELS.gemini.map((m) => ["gemini", m] as [string, string]),
        ];
  const seen = new Set<string>();
  return specs
    .filter(([id, model]) => {
      const key = `${id}:${model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(([id, model]) => makeProvider(id, model, cfg))
    .filter((p): p is LLMProvider => p !== null)
    .filter((p) => !opts.noTraining || p.trainsOnInputs === false);
}

/** Max time a request waits when every model is rate-limited before giving up (free tiers). */
const RATE_LIMIT_WAIT_MS = 8_000;

export function createRouter(cfg: LLMConfig, opts: ChainOptions = {}): ModelRouter {
  return new ModelRouter(buildChain(cfg, opts), Date.now, RATE_LIMIT_WAIT_MS);
}

/**
 * Classification is a small structured-output call, so it goes to the fastest model first (Groq
 * gpt-oss-20b, ~0.7 s in live probes vs up to 50 s for Flash-Lite) and a different Groq model than the agent. Free-tier quotas are per model, so splitting the two call
 * types across models roughly doubles throughput before anything is rate-limited.
 */
export function createClassifierRouter(cfg: LLMConfig, opts: ChainOptions = {}): ModelRouter {
  const chain = buildChain(
    {
      ...cfg,
      LLM_CHAIN:
        cfg.LLM_CHAIN ??
        (cfg.LLM_PROVIDER === "anthropic"
          ? "anthropic:claude-haiku-5-5,gemini:gemini-3.5-flash-lite,groq:openai/gpt-oss-20b"
          : "groq:openai/gpt-oss-20b,gemini:gemini-3.5-flash-lite,gemini:gemini-3.6-flash,gemini:gemini-3.1-flash-lite"),
    },
    opts,
  );
  return new ModelRouter(
    chain.length ? chain : buildChain(cfg, opts),
    Date.now,
    RATE_LIMIT_WAIT_MS,
  );
}

export * from "./types.ts";
export { ModelRouter, RouterExhaustedError, type Attempt, type RoutedResult } from "./router.ts";
