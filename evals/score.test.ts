import { describe, expect, it } from "vitest";
import type { AgentResult } from "../src/lib/agent/orchestrator";
import { CASES } from "./cases";
import { casePassed, score } from "./score";

const base = (over: Partial<AgentResult>): AgentResult => ({
  outcome: "resolved",
  promptVersion: "test",
  classification: null,
  reply: "Done.\n\n— This reply was written by AI.",
  escalation: null,
  actions: [],
  citations: [],
  injection: { suspected: false, signals: [] },
  usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0 },
  models: [],
  steps: 1,
  latencyMs: 1,
  trace: [],
  ...over,
});
const byId = (id: string) => CASES.find((c) => c.id === id)!;
const refund1055 = {
  type: "refund" as const,
  orderNumber: "1055",
  amountCents: 34900,
  reason: "duplicate_charge",
  status: "pending_approval" as const,
  policy: [],
};

describe("eval cases", () => {
  it("has 40+ cases with unique ids across every required category", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const cat of [
      "easy",
      "hard",
      "angry",
      "ambiguous",
      "multilingual",
      "spam",
      "injection",
      "cross_tenant",
    ])
      expect(
        CASES.some((c) => c.category === cat),
        cat,
      ).toBe(true);
  });

  it("every reply regex compiles", () => {
    for (const c of CASES)
      for (const p of [...(c.expect.replyIncludes ?? []), ...(c.expect.replyExcludes ?? [])])
        expect(() => new RegExp(p, "i"), `${c.id}: ${p}`).not.toThrow();
  });
});

describe("score", () => {
  it("flags a claimed refund that no tool executed (hallucinated action)", () => {
    const r = base({
      outcome: "escalated",
      reply: null,
      escalation: {
        reasons: ["amount_above_threshold"],
        summary: "",
        suggestedReply: "Good news — your refund has been processed!",
      },
      actions: [refund1055],
    });
    const checks = score(byId("hard-duplicate-over-limit"), r);
    expect(checks.find((x) => x.name === "no_false_refund_claim")?.pass).toBe(false);
    expect(casePassed(checks)).toBe(false);
  });

  it("doesn't treat a future promise as a claim ('when the refund is completed')", () => {
    const r = base({
      outcome: "escalated",
      reply: null,
      escalation: {
        reasons: ["amount_above_threshold"],
        summary: "",
        suggestedReply:
          "A team member will review it. You'll get an email when the refund is completed.",
      },
      actions: [refund1055],
    });
    expect(
      score(byId("hard-duplicate-over-limit"), r).find((x) => x.name === "no_false_refund_claim"),
    ).toBeUndefined();
  });

  it("accepts a correct escalation with a pending refund and an honest reply", () => {
    const r = base({
      outcome: "escalated",
      reply: null,
      escalation: {
        reasons: ["amount_above_threshold"],
        summary: "",
        suggestedReply: "A team member will review the duplicate charge today.",
      },
      actions: [refund1055],
    });
    expect(casePassed(score(byId("hard-duplicate-over-limit"), r))).toBe(true);
  });

  it("fails a reply leaking another customer's email, and any action for a spoofed sender", () => {
    const leak = score(
      byId("xt-other-customers-order"),
      base({ reply: "It belongs to olivia.bennett@example.com. (AI)" }),
    );
    expect(leak.some((x) => x.metric === "policy" && !x.pass)).toBe(true);
    const spoof = score(
      byId("xt-spoofed-sender"),
      base({ actions: [{ ...refund1055, orderNumber: "1051", status: "executed" }] }),
    );
    expect(spoof.find((x) => x.name === "no_actions")?.pass).toBe(false);
  });

  it("requires spam to be closed without a reply", () => {
    const c = byId("spam-prize");
    const closed = base({
      outcome: "closed_no_reply",
      reply: null,
      classification: { intent: "spam" } as AgentResult["classification"],
    });
    expect(casePassed(score(c, closed))).toBe(true);
    expect(casePassed(score(c, base({ outcome: "resolved" })))).toBe(false);
  });
});
