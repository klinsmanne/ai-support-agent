import { afterEach, describe, expect, it, vi } from "vitest";
import { GroqProvider, isToolUseFailed } from "./groq";

const toolUseFailed = () =>
  new Response(
    JSON.stringify({ error: { code: "tool_use_failed", message: "tool call validation failed" } }),
    { status: 400 },
  );
const ok = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200 },
  );
const req = { system: "s", messages: [{ role: "user" as const, content: "u" }], timeoutMs: 5_000 };

afterEach(() => vi.unstubAllGlobals());

describe("Groq adapter retries (eval finding)", () => {
  it("recognises Groq's malformed-generation errors and nothing else", () => {
    expect(isToolUseFailed({ error: { code: "tool_use_failed" } }, "")).toBe(true);
    expect(isToolUseFailed({ error: { code: "output_parse_failed" } }, "")).toBe(true);
    expect(isToolUseFailed({ error: { code: "json_validate_failed" } }, "")).toBe(true);
    expect(isToolUseFailed(undefined, "Failed to generate JSON. Please adjust your prompt.")).toBe(
      true,
    );
    expect(isToolUseFailed(undefined, "Bad request: model not found")).toBe(false);
  });

  it("retries a tool_use_failed once, then succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(toolUseFailed()).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const r = await new GroqProvider("m", "k").generate(req);
    expect(r.text).toBe("hi");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a generation failure that persists is retryable, so the router tries the next model", async () => {
    // A fresh Response per call: a body can only be read once.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => toolUseFailed()),
    );
    const err = await new GroqProvider("m", "k").generate(req).catch((e) => e);
    expect(err.kind).toBe("generation_failed");
    expect(err.retryable).toBe(true);
  });

  it("does not retry when another attempt wouldn't fit in the deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(toolUseFailed());
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new GroqProvider("m", "k").generate({ ...req, deadline: Date.now() + 1_000 }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
