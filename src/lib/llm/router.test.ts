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

describe("buildChain", () => {
  it("orders Gemini models first, then Groq, skipping providers without keys", () => {
    const chain = buildChain({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g", GROQ_API_KEY: "q" });
    expect(chain.map((p) => `${p.id}:${p.model}`)).toEqual([
      "gemini:gemini-3.8-flash",
      "gemini:gemini-3.6-flash",
      "gemini:gemini-3.5-flash-lite",
      "groq:openai/gpt-oss-120b",
    ]);
    expect(buildChain({ LLM_PROVIDER: "gemini", GROQ_API_KEY: "q" }).map((p) => p.id)).toEqual([
      "groq",
    ]);
  });

  it("switches primary with one env var and keeps the Claude adapter inactive without a key", () => {
    const claudeFirst = buildChain({
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "a",
      GROQ_API_KEY: "q",
    });
    expect(claudeFirst[0].id).toBe("anthropic");
    const noKey = buildChain({ LLM_PROVIDER: "anthropic", GROQ_API_KEY: "q" });
    expect(noKey.map((p) => p.id)).toEqual(["groq"]);
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
