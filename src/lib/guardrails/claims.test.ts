import { describe, expect, it } from "vitest";
import { findClaims, unperformedClaims } from "./claims";
import { validateReply } from "./output";

describe("action claims", () => {
  it("catches a claimed carrier trace, including with a typographic apostrophe", () => {
    // Real eval failure (gpt-oss-20b, easy-wismo-delayed): no tool opens traces.
    const text = "We'll open a trace if needed.\n\nI’ve started that process for you now.";
    expect(unperformedClaims(text, [])).toEqual([
      { type: "investigation", phrase: "I've started that process" },
    ]);
    expect(unperformedClaims("We're opening an internal investigation.", [])[0]?.type).toBe(
      "investigation",
    );
    expect(unperformedClaims("I've contacted the carrier about it.", [])[0]?.type).toBe(
      "investigation",
    );
  });

  it("allows a claim that code actually executed", () => {
    expect(unperformedClaims("I've processed a refund of $49.", ["refund"])).toEqual([]);
    expect(unperformedClaims("I've processed a refund of $49.", [])[0]?.type).toBe("refund");
  });

  it("treats promises and honest pending status as non-claims", () => {
    for (const text of [
      "You'll get an email when the refund is completed.",
      "Your refund request has been submitted for review.",
      "If the parcel isn't found, we'll open a trace with the carrier.",
      "Once your address has been updated, we'll confirm by email.",
    ])
      expect(findClaims(text), text).toEqual([]);
  });
});

describe("validateReply with executed actions", () => {
  const ctx = { canary: "c4n4ry", allowedLinkDomains: [], internalIds: [] };
  it("blocks an unperformed claim only when executed actions are given", () => {
    const reply = "Good news: your refund has been processed!";
    expect(validateReply(reply, { ...ctx, executedActions: [] }).violations).toContain(
      "unperformed_action_claim:refund",
    );
    expect(validateReply(reply, { ...ctx, executedActions: ["refund"] }).ok).toBe(true);
  });
});
