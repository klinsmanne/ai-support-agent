import { describe, expect, it } from "vitest";
import { buildChain } from "./index";
import { ModelRouter, RouterExhaustedError } from "./router";
import { LLMError, type GenerateRequest, type GenerateResult, type LLMProvider } from "./types";

const req: GenerateRequest = {
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  timeoutMs: 1000,
};

function fake(
  model: string,
  behaviour: () => GenerateResult | never,
): LLMProvider & { calls: number } {
  return {
    id: "mock",
    model,
    calls: 0,
    async generate() {
      this.calls++;
      return behaviour();
    },
  };
}
const ok = (model: string): GenerateResult => ({
  provider: "mock",
  model,
  text: "ok",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
  latencyMs: 1,
});
const fail = (kind: LLMError["kind"], model: string) => () => {
  throw new LLMError(kind, kind, "mock", model);
};

describe("ModelRouter", () => {
  it("falls back to the next model on retryable errors and records attempts", async () => {
    const a = fake("a", fail("unavailable", "a"));
    const b = fake("b", () => ok("b"));
    const { result, attempts } = await new ModelRouter([a, b]).generate(req);
    expect(result.model).toBe("b");
    expect(attempts.map((x) => [x.model, x.ok])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("opens a circuit so a failing model is skipped until its cool-down ends", async () => {
    let now = 0;
    const a = fake("a", fail("rate_limit", "a"));
    const b = fake("b", () => ok("b"));
    const router = new ModelRouter([a, b], () => now);
    await router.generate(req);
    await router.generate(req);
    expect(a.calls).toBe(1); // skipped on the second request
    now += 61_000;
    await router.generate(req);
    expect(a.calls).toBe(2); // retried after cool-down
  });

  it("fails fast on non-retryable errors (a bad request won't be fixed by another model)", async () => {
    const a = fake("a", fail("bad_request", "a"));
    const b = fake("b", () => ok("b"));
    await expect(new ModelRouter([a, b]).generate(req)).rejects.toBeInstanceOf(
      RouterExhaustedError,
    );
    expect(b.calls).toBe(0);
  });

  it("still tries the last model even if its circuit is open", async () => {
    let now = 0;
    const only = fake("only", fail("unavailable", "only"));
    const router = new ModelRouter([only], () => now);
    await expect(router.generate(req)).rejects.toThrow();
    await expect(router.generate(req)).rejects.toThrow();
    expect(only.calls).toBe(2);
    now++;
  });
});

describe("rate-limit wait", () => {
  it("waits for the provider's retry hint and retries once when every model is rate-limited", async () => {
    let calls = 0;
    const flaky = fake("a", () => {
      if (++calls === 1)
        throw new LLMError("rate_limit", "Quota exceeded. Please retry in 1.5s.", "mock", "a");
      return ok("a");
    });
    const waits: number[] = [];
    const router = new ModelRouter([flaky], Date.now, 8_000, async (ms) => void waits.push(ms));
    const { result, attempts } = await router.generate({ ...req, timeoutMs: 10_000 });
    expect(result.model).toBe("a");
    expect(waits).toEqual([1500]); // the provider's hint, under both the cap and the request timeout
    expect(attempts.some((x) => x.error?.kind === "rate_limit_wait")).toBe(true);
  });

  it("does not wait when failures aren't rate limits", async () => {
    const a = fake("a", fail("unavailable", "a"));
    const waits: number[] = [];
    await expect(
      new ModelRouter([a], Date.now, 8_000, async (ms) => void waits.push(ms)).generate(req),
    ).rejects.toThrow();
    expect(waits).toEqual([]);
  });

  it("parses retry hints from Gemini and Groq messages", async () => {
    const { retryHintMs } = await import("./router");
    expect(retryHintMs("Please retry in 12.3s.")).toBe(12_300);
    expect(retryHintMs("Rate limit reached. Please try again in 2.5s")).toBe(2_500);
    expect(retryHintMs("try again in 750ms")).toBe(750);
    expect(retryHintMs("nothing here")).toBeNull();
  });
});

describe("buildChain", () => {
  it("puts the eval-measured models first, skipping providers without keys (ADR-022)", () => {
    const chain = buildChain({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g", GROQ_API_KEY: "q" });
    expect(chain.map((p) => `${p.id}:${p.model}`)).toEqual([
      "gemini:gemini-3.5-flash-lite",
      "groq:openai/gpt-oss-20b",
      "gemini:gemini-3.8-flash",
      "gemini:gemini-3.6-flash",
      "groq:openai/gpt-oss-120b",
      "gemini:gemini-3.5-flash",
    ]);
    expect(
      buildChain({ LLM_PROVIDER: "gemini", GROQ_API_KEY: "q" }).map((p) => `${p.id}:${p.model}`),
    ).toEqual(["groq:openai/gpt-oss-20b", "groq:openai/gpt-oss-120b"]);
  });

  it("noTraining keeps only providers whose terms forbid training on inputs", () => {
    const cfg = { LLM_PROVIDER: "gemini" as const, GEMINI_API_KEY: "g", GROQ_API_KEY: "q" };
    expect(buildChain(cfg, { noTraining: true }).map((p) => p.id)).toEqual(["groq", "groq"]);
    // A billing-enabled Gemini project is allowed (paid terms: no training on prompts).
    expect(
      buildChain({ ...cfg, GEMINI_PAID_TIER: "true" }, { noTraining: true }).some(
        (p) => p.id === "gemini",
      ),
    ).toBe(true);
    expect(buildChain({ ...cfg, GROQ_API_KEY: undefined }, { noTraining: true })).toEqual([]);
  });

  it("switches primary with one env var and keeps the Claude adapter inactive without a key", () => {
    const claudeFirst = buildChain({
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "a",
      GROQ_API_KEY: "q",
    });
    expect(claudeFirst[0].id).toBe("anthropic");
    const noKey = buildChain({ LLM_PROVIDER: "anthropic", GROQ_API_KEY: "q" });
    expect(noKey.map((p) => p.id)).toEqual(["groq", "groq"]); // no Anthropic adapter without a key
  });

  it("honors an explicit LLM_CHAIN and LLM_MODEL override", () => {
    const chain = buildChain({
      LLM_PROVIDER: "gemini",
      LLM_CHAIN: "groq:openai/gpt-oss-20b, gemini:gemini-3.6-flash",
      GEMINI_API_KEY: "g",
      GROQ_API_KEY: "q",
    });
    expect(chain.map((p) => p.model)).toEqual(["openai/gpt-oss-20b", "gemini-3.6-flash"]);
    const override = buildChain({
      LLM_PROVIDER: "gemini",
      LLM_MODEL: "gemini-3.5-flash",
      GEMINI_API_KEY: "g",
    });
    expect(override[0].model).toBe("gemini-3.5-flash");
  });
});

describe("daily free-tier quotas (live finding 2026-11-03)", () => {
  it("classifies Gemini per-day vs per-minute quota violations", async () => {
    const { geminiError } = await import("./gemini");
    const daily = geminiError(429, {
      error: {
        message: "You exceeded your current quota",
        details: [
          { violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
          { retryDelay: "40s" },
        ],
      },
    });
    expect(daily[0]).toBe("quota_exhausted");
    const perMinute = geminiError(429, {
      error: {
        message: "Quota exceeded",
        details: [
          { violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] },
          { retryDelay: "12s" },
        ],
      },
    });
    expect(perMinute).toEqual(["rate_limit", expect.stringContaining("Please retry in 12s.")]);
  });

  it("classifies Groq daily limits", async () => {
    const { classify429 } = await import("./types");
    expect(
      classify429("Rate limit reached for model openai/gpt-oss-120b on requests per day (RPD)"),
    ).toBe("quota_exhausted");
    expect(
      classify429("Rate limit reached on tokens per minute (TPM). Please try again in 2.1s"),
    ).toBe("rate_limit");
  });

  it("skips an exhausted model for an hour and never waits on it", async () => {
    let now = 0;
    const exhausted = fake("a", fail("quota_exhausted", "a"));
    const backup = fake("b", () => ok("b"));
    const waits: number[] = [];
    const router = new ModelRouter(
      [exhausted, backup],
      () => now,
      8_000,
      async (ms) => void waits.push(ms),
    );
    await router.generate(req);
    now += 30 * 60_000; // 30 minutes later: still skipped
    await router.generate(req);
    expect(exhausted.calls).toBe(1);
    now += 31 * 60_000; // after an hour: probed again
    await router.generate(req);
    expect(exhausted.calls).toBe(2);
    expect(waits).toEqual([]);
  });

  it("does not wait when a rate limit comes without a retry hint", async () => {
    const a = fake("a", () => {
      throw new LLMError("rate_limit", "Too many requests", "mock", "a");
    });
    const waits: number[] = [];
    await expect(
      new ModelRouter([a], Date.now, 8_000, async (ms) => void waits.push(ms)).generate({
        ...req,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
    expect(waits).toEqual([]);
  });
});
