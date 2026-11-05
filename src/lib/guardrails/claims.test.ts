import { describe, expect, it } from "vitest";
import { claimableTypes, findClaims, unperformedClaims } from "./claims";
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

describe("bypass attempts (security review)", () => {
  it("an opener like 'Once again' or 'After review,' doesn't turn a claim into a promise", () => {
    for (const text of [
      "Once again, your refund has been processed.",
      "Once again your refund has been processed.",
      "When you wrote in, your refund has been processed.",
      "After review, your refund was approved.",
    ])
      expect(unperformedClaims(text, [])[0]?.type, text).toBe("refund");
  });

  it("invisible characters inside a word don't hide the claim", () => {
    expect(unperformedClaims("I've proc\u200Bessed a re\u00ADfund for you.", [])[0]?.type).toBe(
      "refund",
    );
  });
});

describe("claimableTypes", () => {
  const a = (type: string, status: string) => ({ type, status });
  it("counts executed, already-done and single proposed actions, never pending approval", () => {
    expect(claimableTypes([a("refund", "executed")])).toEqual(["refund"]);
    expect(claimableTypes([a("refund", "duplicate_ignored")])).toEqual(["refund"]);
    expect(claimableTypes([a("refund", "proposed")])).toEqual(["refund"]);
    expect(claimableTypes([a("refund", "pending_approval")])).toEqual([]);
    expect(claimableTypes([a("refund", "denied")])).toEqual([]);
  });

  it("ignores proposed actions when more than one is pending (approval carries only one)", () => {
    expect(claimableTypes([a("refund", "proposed"), a("address_change", "proposed")])).toEqual([]);
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

describe("validateReply checks the reply as email sends it (security review)", () => {
  const ctx = {
    canary: "c4n4ry",
    allowedLinkDomains: ["hp.example"],
    internalIds: ["0f8fad5b-d9cb-469f-a165-70867728950e"],
  };
  it("formatting can't hide an unapproved link, a blocked scheme or an internal id", () => {
    for (const reply of [
      "See **https**://evil.com/login",
      "See `https`://evil.com/login",
      "Go to evil**.**com/login",
      "Visit **http**://evil.com",
      "Your ticket is **0f8fad5b**-d9cb-469f-a165-70867728950e",
    ])
      expect(validateReply(reply, ctx).ok, reply).toBe(false);
  });

  it("still allows formatted text with approved links", () => {
    expect(validateReply("**Returns:** see https://hp.example/returns", ctx).ok).toBe(true);
  });
});
