import { LLMError, type GenerateRequest, type GenerateResult, type LLMProvider } from "./types.ts";

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  error?: { kind: string; message: string; status?: number };
  skipped?: "circuit_open";
}

export interface RoutedResult {
  result: GenerateResult;
  attempts: Attempt[];
}

/** Cool-down per error kind: how long a failing model is skipped before being retried. */
const COOLDOWN_MS: Record<string, number> = {
  rate_limit: 60_000,
  unavailable: 30_000,
  timeout: 30_000,
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
  ) {
    if (!chain.length) throw new Error("ModelRouter needs at least one provider");
  }

  get models(): string[] {
    return this.chain.map((p) => `${p.id}:${p.model}`);
  }

  async generate(req: GenerateRequest): Promise<RoutedResult> {
    const attempts: Attempt[] = [];
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
      const started = this.now();
      try {
        const result = await provider.generate(req);
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
