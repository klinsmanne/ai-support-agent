import { AnthropicProvider } from "./anthropic.ts";
import { GeminiProvider } from "./gemini.ts";
import { GroqProvider } from "./groq.ts";
import { ModelRouter } from "./router.ts";
import type { LLMProvider } from "./types.ts";

export const DEFAULT_MODELS = {
  gemini: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"],
  groq: ["openai/gpt-oss-120b"],
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
}

function makeProvider(id: string, model: string, cfg: LLMConfig): LLMProvider | null {
  if (id === "gemini" && cfg.GEMINI_API_KEY) return new GeminiProvider(model, cfg.GEMINI_API_KEY);
  if (id === "groq" && cfg.GROQ_API_KEY) return new GroqProvider(model, cfg.GROQ_API_KEY);
  if (id === "anthropic" && cfg.ANTHROPIC_API_KEY)
    return new AnthropicProvider(model, cfg.ANTHROPIC_API_KEY);
  return null; // provider without a key is simply left out of the chain
}

/**
 * Builds the fallback chain from configuration. Switching the primary model is one env var
 * (LLM_PROVIDER / LLM_MODEL); Groq is always appended as the cross-provider fallback.
 */
export function buildChain(cfg: LLMConfig): LLMProvider[] {
  const specs: [string, string][] = cfg.LLM_CHAIN
    ? cfg.LLM_CHAIN.split(",").map((s) => {
        const [id, ...rest] = s.trim().split(":");
        return [id, rest.join(":")];
      })
    : [
        ...(cfg.LLM_MODEL ? [[cfg.LLM_PROVIDER, cfg.LLM_MODEL] as [string, string]] : []),
        ...DEFAULT_MODELS[cfg.LLM_PROVIDER].map((m) => [cfg.LLM_PROVIDER, m] as [string, string]),
        ...(cfg.LLM_PROVIDER !== "gemini"
          ? DEFAULT_MODELS.gemini.map((m) => ["gemini", m] as [string, string])
          : []),
        ...(cfg.LLM_PROVIDER !== "groq"
          ? DEFAULT_MODELS.groq.map((m) => ["groq", m] as [string, string])
          : []),
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
    .filter((p): p is LLMProvider => p !== null);
}

export function createRouter(cfg: LLMConfig): ModelRouter {
  return new ModelRouter(buildChain(cfg));
}

export * from "./types.ts";
export { ModelRouter, RouterExhaustedError, type Attempt, type RoutedResult } from "./router.ts";
