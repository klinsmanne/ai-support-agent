import { describe, expect, it } from "vitest";
import { verifyTurnstile } from "./turnstile";

const ok = (body: object) => (async () => new Response(JSON.stringify(body))) as typeof fetch;

describe("verifyTurnstile", () => {
  it("fails closed in production without a secret, allows local dev without one", async () => {
    expect(await verifyTurnstile("t", "1.2.3.4", { NODE_ENV: "production" })).toBe(false);
    expect(await verifyTurnstile("t", "1.2.3.4", { NODE_ENV: "development" })).toBe(true);
  });
  it("rejects a missing token, a failed check, an unreachable Cloudflare, or another site's token", async () => {
    const env = {
      TURNSTILE_SECRET_KEY: "s",
      NODE_ENV: "production",
      APP_URL: "https://demo.example",
    };
    expect(await verifyTurnstile(undefined, "ip", env, ok({ success: true }))).toBe(false);
    expect(await verifyTurnstile("t", "ip", env, ok({ success: false }))).toBe(false);
    const down = (async () => {
      throw new Error("network");
    }) as typeof fetch;
    expect(await verifyTurnstile("t", "ip", env, down)).toBe(false);
    expect(
      await verifyTurnstile("t", "ip", env, ok({ success: true, hostname: "evil.example" })),
    ).toBe(false);
    expect(
      await verifyTurnstile("t", "ip", env, ok({ success: true, hostname: "demo.example" })),
    ).toBe(true);
  });
});
