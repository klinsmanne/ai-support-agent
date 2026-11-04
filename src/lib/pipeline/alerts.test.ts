import { describe, expect, it } from "vitest";
import { reportFailure } from "./alerts";

function counterStore() {
  const counts = new Map<string, number>();
  return {
    rateLimit: async (key: string, _w: number, max: number) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n <= max;
    },
  };
}

describe("reportFailure", () => {
  it("alerts once on the third failure of a kind, then stays quiet for the window", async () => {
    const store = counterStore();
    const sent: { subject: string; body: string }[] = [];
    const send = async (subject: string, body: string) => void sent.push({ subject, body });
    const results = [];
    for (let i = 0; i < 6; i++)
      results.push(await reportFailure(store, send, "pipeline_email", "boom for x@y.com"));
    expect(results).toEqual([false, false, true, false, false, false]);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("pipeline_email");
    expect(sent[0].body).not.toContain("x@y.com"); // PII masked before it leaves the system
  });

  it("counts kinds separately, and never throws when sending fails", async () => {
    const store = counterStore();
    const failing = async () => {
      throw new Error("smtp down");
    };
    for (let i = 0; i < 2; i++) await reportFailure(store, failing, "a", "e");
    await expect(reportFailure(store, failing, "b", "e")).resolves.toBe(false);
    await expect(reportFailure(store, failing, "a", "e")).resolves.toBe(false);
    expect(await reportFailure(store, null, "a", "e")).toBe(false);
  });
});
