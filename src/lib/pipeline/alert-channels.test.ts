import { describe, expect, it, vi } from "vitest";
import { fanOut, ntfySender } from "./alert-channels";

describe("ntfy push alerts", () => {
  it("posts the alert to the topic with an ASCII title and high priority", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await ntfySender("t0p1c-Secret_abcdefgh", fetchFn)(
      "[Support Ops] Repeated failures: gmail_poll",
      "body",
    );
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://ntfy.sh/t0p1c-Secret_abcdefgh");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Priority: "high",
      Title: "[Support Ops] Repeated failures: gmail_poll",
    });
    expect(init.body).toBe("body");
  });

  it("throws on a non-2xx response so the fan-out knows it failed", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    await expect(ntfySender("topic-abcdefghijklmnop", fetchFn)("s", "b")).rejects.toThrow(/429/);
  });
});

describe("fanOut", () => {
  it("succeeds when one channel works even if another fails (Gmail down → push still arrives)", async () => {
    const email = vi.fn().mockRejectedValue(new Error("gmail token expired"));
    const push = vi.fn().mockResolvedValue(undefined);
    await expect(fanOut([email, push])("s", "b")).resolves.toBeUndefined();
    expect(push).toHaveBeenCalledWith("s", "b");
  });

  it("fails only when every channel fails", async () => {
    const bad = vi.fn().mockRejectedValue(new Error("x"));
    await expect(fanOut([bad, bad])("s", "b")).rejects.toThrow(/every alert channel failed/);
  });
});
