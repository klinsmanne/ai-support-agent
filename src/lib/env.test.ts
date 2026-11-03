import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./env";

describe("parseServerEnv", () => {
  it("applies safe defaults when optional values are missing", () => {
    const env = parseServerEnv({});
    expect(env.LLM_PROVIDER).toBe("gemini");
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects an unknown model provider", () => {
    expect(() => parseServerEnv({ LLM_PROVIDER: "made-up" })).toThrow(/LLM_PROVIDER/);
  });

  it("never echoes secret values in the error message", () => {
    const secret = "not-a-url-super-secret";
    expect(() => parseServerEnv({ NEXT_PUBLIC_SUPABASE_URL: secret })).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    );
    try {
      parseServerEnv({ NEXT_PUBLIC_SUPABASE_URL: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
