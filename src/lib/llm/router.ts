import { LLMError, type GenerateRequest, type GenerateResult, type LLMProvider } from "./types.ts";

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  error?: { kind: string; message: string; status?: number };
  skipped?: "circuit_open" | "deadline";
}

export interface RoutedResult {
  result: GenerateResult;
  attempts: Attempt[];
}

/** Cool-down per error kind: how long a failing model is skipped before being retried. */
/** An attempt with less time than this left isn't worth starting. */
const MIN_ATTEMPT_MS = 1_500;

const COOLDOWN_MS: Record<string, number> = {
  rate_limit: 60_000,
  // Free-tier daily quotas reset at midnight Pacific; re-probing hourly is cheap (~100 ms).
  quota_exhausted: 60 * 60_000,
  unavailable: 30_000,
  timeout: 30_000,
  // One bad generation says nothing about the model's health: fall through, but no cooldown,
  // so a crafted message can't switch a model off for everyone (security review).
  generation_failed: 0,
};

/**
 * Tries providers in order. Retryable failures (429, 5xx, timeouts) open a short circuit for
 * that model and fall through to the next one; non-retryable errors (bad request, auth) fail
 * fast because another model won't fix a malformed request. Every attempt is recorded for tracing.
 */
export class ModelRouter {
  // Per-instance state; on serverless this resets with cold starts, which is acceptable.
  private readonly openUntil = new Map<string, number>();

  constructor(
    private readonly chain: LLMProvider[],
    private readonly now: () => number = Date.now,
    /**
     * When every model fails with rate limits, wait this long at most (using the provider's
     * "retry in Ns" hint) and try the chain once more. 0 disables waiting (tests).
     */
    private readonly maxRateLimitWaitMs = 0,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!chain.length) throw new Error("ModelRouter needs at least one provider");
  }

  get models(): string[] {
    return this.chain.map((p) => `${p.id}:${p.model}`);
  }

  async generate(req: GenerateRequest): Promise<RoutedResult> {
    try {
      return await this.pass(req, []);
    } catch (error) {
      if (!(error instanceof RouterExhaustedError) || !this.maxRateLimitWaitMs) throw error;
      const tried = error.attempts.filter((a) => !a.skipped);
      if (!tried.length || !tried.every((a) => a.error?.kind === "rate_limit")) throw error;
      // Only wait when every provider gave an explicit retry hint (a short per-minute window).
      // Daily quotas (quota_exhausted) never qualify: waiting can't help, the next model can.
      const hints = tried.map((a) => retryHintMs(a.error?.message ?? ""));
      if (hints.some((h) => h === null)) throw error;
      const hinted = Math.min(...(hints as number[]));
      // Only wait if the wait plus a minimal call still fits before the deadline.
      const left = (req.deadline ?? this.now() + req.timeoutMs) - this.now() - MIN_ATTEMPT_MS;
      const waitMs = Math.min(hinted, this.maxRateLimitWaitMs, Math.max(left, 0));
      if (waitMs <= 0) throw error;
      await this.sleep(waitMs);
      this.openUntil.clear(); // second pass ignores circuits: everyone was just rate-limited
      return this.pass(req, [
        ...error.attempts,
        {
          provider: "router",
          model: "-",
          ok: false,
          latencyMs: waitMs,
          error: { kind: "rate_limit_wait", message: `waited ${waitMs} ms` },
        },
      ]);
    }
  }

  private async pass(req: GenerateRequest, attempts: Attempt[]): Promise<RoutedResult> {
    let lastError: LLMError | undefined;

    for (const [index, provider] of this.chain.entries()) {
      const key = `${provider.id}:${provider.model}`;
      const isLast = index === this.chain.length - 1;
      // Never skip the last option: trying a cooling-down model beats failing outright.
      if (!isLast && (this.openUntil.get(key) ?? 0) > this.now()) {
        attempts.push({
          provider: provider.id,
          model: provider.model,
          ok: false,
          latencyMs: 0,
          skipped: "circuit_open",
        });
        continue;
      }
      const remaining = (req.deadline ?? Infinity) - this.now();
      if (remaining < MIN_ATTEMPT_MS) {
        attempts.push({
          provider: provider.id,
          model: provider.model,
          ok: false,
          latencyMs: 0,
          skipped: "deadline",
        });
        break;
      }
      const started = this.now();
      try {
        const result = await provider.generate({
          ...req,
          timeoutMs: Math.min(req.timeoutMs, remaining),
        });
        this.openUntil.delete(key);
        attempts.push({
          provider: provider.id,
          model: provider.model,
          ok: true,
          latencyMs: this.now() - started,
        });
        return { result, attempts };
      } catch (error) {
        const err =
          error instanceof LLMError
            ? error
            : new LLMError("unknown", (error as Error).message, provider.id, provider.model);
        attempts.push({
          provider: provider.id,
          model: provider.model,
          ok: false,
          latencyMs: this.now() - started,
          error: { kind: err.kind, message: err.message, status: err.status },
        });
        lastError = err;
        if (!err.retryable) break;
        this.openUntil.set(key, this.now() + (COOLDOWN_MS[err.kind] ?? 30_000));
      }
    }
    throw new RouterExhaustedError(attempts, lastError);
  }
}

/** Parses provider retry hints such as "Please retry in 12.3s" (Gemini) or "try again in 2.5s" (Groq). */
export function retryHintMs(message: string): number | null {
  const m = /(?:retry|try again) in ([\d.]+)\s*(ms|s)\b/i.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.ceil(m[2].toLowerCase() === "ms" ? n : n * 1000) : null;
}

export class RouterExhaustedError extends Error {
  constructor(
    readonly attempts: Attempt[],
    readonly cause?: LLMError,
  ) {
    super(
      `All models failed: ${attempts.map((a) => `${a.model}=${a.error?.kind ?? a.skipped}`).join(", ")}`,
    );
    this.name = "RouterExhaustedError";
  }
}
