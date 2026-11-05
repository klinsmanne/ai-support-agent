/**
 * Smoke tests against a deployed site (production by default). They check what a visitor and an
 * attacker would see over HTTP: pages render, security headers are set, and the protected
 * endpoints refuse unauthenticated or bot traffic. No model calls, no writes, no secrets needed.
 *
 *   npm run e2e                                   # https://ai-support-ops-agent.vercel.app
 *   E2E_BASE_URL=https://<other-host> npm run e2e
 *
 * CI runs them once each push to main is live, and daily (.github/workflows/e2e.yml).
 */
import { describe, expect, it } from "vitest";

const BASE = (process.env.E2E_BASE_URL ?? "https://ai-support-ops-agent.vercel.app").replace(
  /\/$/,
  "",
);
const get = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, { redirect: "manual", ...init });

describe(`live site: ${BASE}`, () => {
  it("serves the landing page with the product pitch and the try-it chat", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Support Ops Agent/);
    expect(html).toMatch(/Try it/);
    expect(html).toMatch(/fictional/i); // the demo-data notice is visible
  });

  it("serves the privacy policy and terms (required by the Gmail OAuth app)", async () => {
    for (const path of ["/privacy", "/terms"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
    }
    expect(await (await get("/privacy")).text()).toMatch(/Limited Use/);
  });

  it("reports healthy", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    // The deployed commit lets CI wait for the new build; locally it may be null.
    expect(body.commit === null || /^[0-9a-f]{7}$/.test(body.commit)).toBe(true);
  });

  it("sends the security headers (ADR-021)", async () => {
    const h = (await get("/")).headers;
    expect(h.get("content-security-policy")).toMatch(/frame-ancestors 'none'|default-src 'self'/);
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(h.get("referrer-policy")).toBeTruthy();
  });

  it("keeps the dashboard behind sign-in", async () => {
    const res = await get("/dashboard");
    expect([302, 303, 307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("refuses cross-site chat requests (CSRF)", async () => {
    const res = await get("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ tenant: "harbor-pine", message: "hi" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses to start a chat session without a Turnstile token (bots can't spend quota)", async () => {
    const res = await get("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ tenant: "harbor-pine", message: "What is your return policy?" }),
    });
    // 403 = bot check refused; 429 = per-IP rate limit (also a refusal, e.g. on repeated runs).
    expect([403, 429]).toContain(res.status);
    expect(JSON.stringify(await res.json())).not.toMatch(/return policy/i);
  });

  it("rejects Gmail poll and escalation-digest calls without the cron secret", async () => {
    for (const path of ["/api/channels/gmail/poll", "/api/cron/escalation-digest"])
      for (const authorization of [undefined, "Bearer wrong-secret-wrong-secret-wrong-secret"]) {
        const res = await get(path, {
          method: "POST",
          headers: authorization ? { authorization } : {},
        });
        expect(res.status).toBe(401);
      }
  });
});
