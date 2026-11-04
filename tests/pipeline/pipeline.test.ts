import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRepo } from "@/lib/agent/memory-repo";
import type { Classification } from "@/lib/agent/classify";
import type { InboundMessage, OutboundReply } from "@/lib/channels/types";
import type { GenerateRequest, ToolCall } from "@/lib/llm/types";
import { ingestMessage, type PipelineDeps } from "@/lib/pipeline/ingest";
import { MemoryStore } from "@/lib/pipeline/memory-store";
import { loadTenantFolders } from "@/lib/tenants/load";

const tenants = loadTenantFolders(join(import.meta.dirname, "..", "..", "tenants"));
const HP = MemoryRepo.tenantId("harbor-pine");
const CA = MemoryRepo.tenantId("cadence-analytics");
const INBOX = "integralplantsupport@gmail.com";

const cls: Classification = {
  intent: "order_status",
  urgency: "normal",
  sentiment: 0,
  language: "en",
  wants_human: false,
  injection_attempt: false,
  order_numbers: [],
  confidence: 0.9,
  summary: "s",
};
const call = (name: string, args: unknown = {}): ToolCall => ({
  id: `${name}-${Math.random()}`,
  name,
  arguments: args,
});

function router(steps: (ToolCall[] | string)[], classification: Partial<Classification> = {}) {
  let i = 0;
  const calls: GenerateRequest[] = [];
  return {
    calls,
    async generate(req: GenerateRequest) {
      calls.push(req);
      const base = {
        provider: "mock" as const,
        model: "m",
        usage: { inputTokens: 10, outputTokens: 5 },
        latencyMs: 1,
      };
      if (req.responseSchema)
        return {
          result: {
            ...base,
            text: JSON.stringify({ ...cls, ...classification }),
            toolCalls: [],
            finishReason: "stop" as const,
          },
          attempts: [],
        };
      const s = steps[Math.min(i++, steps.length - 1)];
      return {
        result:
          typeof s === "string"
            ? { ...base, text: s, toolCalls: [], finishReason: "stop" as const }
            : { ...base, text: "", toolCalls: s, finishReason: "tool_calls" as const },
        attempts: [],
      };
    },
  };
}

let repo: MemoryRepo;
let store: MemoryStore;
let sent: OutboundReply[];
const deps = (r: ReturnType<typeof router>): PipelineDeps => ({
  store,
  repo,
  router: r,
  sender: {
    send: async (reply) => (sent.push(reply), { providerMessageId: `sent-${sent.length}` }),
  },
  inboxAddress: INBOX,
  defaultTenantSlug: "harbor-pine",
});

const email = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "email",
  providerMessageId: `gm-${Math.random()}`,
  threadKey: "thread-1",
  from: { email: "olivia.bennett@example.com", name: "Olivia" },
  to: [INBOX],
  subject: "Order 1042",
  text: "Where is my order #1042?",
  receivedAt: new Date().toISOString(),
  auth: { spf: "pass", dkim: "pass", dmarc: "pass", aligned: true },
  headers: { "message-id": "<m1@mail.example.com>" },
  ...over,
});

beforeEach(() => {
  repo = new MemoryRepo(tenants);
  store = new MemoryStore(repo, { "harbor-pine": HP, "cadence-analytics": CA });
  sent = [];
});

describe("email pipeline", () => {
  it("auto-send tenant: verified customer gets a threaded reply; ticket resolved", async () => {
    const r = router([
      [call("get_orders", { order_number: "1042" })],
      [call("send_reply", { message: "It's delayed, new ETA Friday." })],
    ]);
    const res = await ingestMessage(email(), deps(r));
    expect(res).toMatchObject({ status: "processed", outcome: "resolved", delivered: "sent" });
    expect(sent[0]).toMatchObject({
      to: "olivia.bennett@example.com",
      threadKey: "thread-1",
      inReplyTo: "<m1@mail.example.com>",
    });
    expect(sent[0].body).toMatch(/written by AI/);
    expect(store.tickets[0]).toMatchObject({
      status: "resolved",
      sender_verified: true,
      intent: "order_status",
      ai_reply_count: 1,
    });
    expect(store.tickets[0].first_response_at).toBeTruthy();
  });

  it("email uses the no-training model set when one is configured (Gmail Limited Use)", async () => {
    const general = router([[call("send_reply", { message: "general" })]]);
    const privateR = router([
      [call("get_orders", { order_number: "1042" })],
      [call("send_reply", { message: "It's delayed, new ETA Friday." })],
    ]);
    let generalCalls = 0;
    const counting = {
      generate: (req: GenerateRequest) => (generalCalls++, general.generate(req)),
    };
    const d = { ...deps(counting as ReturnType<typeof router>), email: { router: privateR, repo } };
    const res = await ingestMessage(email(), d);
    expect(res).toMatchObject({ status: "processed", delivered: "sent" });
    expect(generalCalls).toBe(0);
    expect(sent[0].body).toMatch(/new ETA Friday/);
  });

  it("never processes the same Gmail message twice", async () => {
    const r = router([[call("send_reply", { message: "Hi" })]]);
    const m = email();
    await ingestMessage(m, deps(r));
    expect(await ingestMessage(m, deps(r))).toEqual({ status: "duplicate" });
    expect(sent).toHaveLength(1);
  });

  it("follow-ups thread into the same ticket and the agent sees the history", async () => {
    const r = router([[call("send_reply", { message: "Checking now." })]]);
    await ingestMessage(email({ text: "First message" }), deps(r));
    await ingestMessage(email({ text: "Any update?" }), deps(r));
    expect(store.tickets).toHaveLength(1);
    const lastAgentCall = r.calls.filter((c) => c.tools).at(-1)!;
    const firstUserTurn = lastAgentCall.messages[0];
    expect(firstUserTurn.role === "user" && firstUserTurn.content).toMatch(
      /First message[\s\S]*Checking now[\s\S]*Any update/,
    );
  });

  it("does not trust a customer address that failed SPF/DKIM/DMARC (spoofing)", async () => {
    const r = router([
      [call("get_orders", { order_number: "1042" })],
      [call("send_reply", { message: "General help only." })],
    ]);
    await ingestMessage(
      email({ auth: { spf: "fail", dkim: "fail", dmarc: "fail", aligned: false } }),
      deps(r),
    );
    expect(store.tickets[0]).toMatchObject({ sender_verified: false });
    expect(store.runs[0].result.trace.find((t) => t.name === "get_orders")?.output).toMatchObject({
      error: "sender_not_verified",
    });
  });

  it.each([
    ["auto-reply", { headers: { "auto-submitted": "auto-replied" } }],
    ["our own address (loop)", { from: { email: INBOX, name: null } }],
    ["newsletter", { headers: { "list-unsubscribe": "<mailto:u@x>" } }],
  ])("closes %s without calling the model or replying", async (_label, over) => {
    const r = router([[call("send_reply", { message: "should not happen" })]]);
    const res = await ingestMessage(email(over as Partial<InboundMessage>), deps(r));
    expect(res.status).toBe("skipped");
    expect(r.calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(store.tickets[0]).toMatchObject({ status: "closed" });
  });

  it("routes +cadence mail to the Cadence tenant", async () => {
    const r = router([[call("send_reply", { message: "Use the reset page." })]]);
    await ingestMessage(
      email({
        to: ["integralplantsupport+cadence@gmail.com"],
        from: { email: "ava.chen@example.org", name: null },
      }),
      deps(r),
    );
    expect(store.tickets[0].tenant_id).toBe(CA);
  });

  it("draft_only tenant (Cadence): reply is held for approval, nothing is sent", async () => {
    const r = router([[call("send_reply", { message: "Use the reset page." })]], {
      intent: "account_access",
    });
    const res = await ingestMessage(
      email({
        to: ["integralplantsupport+cadence@gmail.com"],
        from: { email: "ava.chen@example.org", name: null },
      }),
      deps(r),
    );
    expect(res).toMatchObject({ delivered: "pending_approval" });
    expect(sent).toHaveLength(0);
    expect(store.escalations[0].reasonCodes).toEqual(["draft_review"]);
    expect(store.messages.find((m) => m.direction === "outbound")?.status).toBe("pending_approval");
  });

  it("a draft that proposes a refund carries it, so approving the draft executes it (review finding)", async () => {
    repo.setRolloutMode(HP, "draft_only");
    const r = router(
      [
        [
          call("issue_refund", {
            order_number: "1051",
            amount_cents: 6400,
            reason: "duplicate_charge",
          }),
        ],
        [call("send_reply", { message: "Your refund is on its way." })],
      ],
      { intent: "refund_or_billing" },
    );
    await ingestMessage(
      email({
        from: { email: "marcus.lee@example.com", name: null },
        text: "Charged twice for 1051",
      }),
      deps(r),
    );
    expect(store.escalations[0].reasonCodes).toEqual(["draft_review"]);
    expect(store.escalations[0].pendingAction).toMatchObject({
      type: "refund",
      orderNumber: "1051",
      amountCents: 6400,
      status: "proposed",
    });
    expect(repo.refunds).toHaveLength(0); // nothing moves until a human approves
  });

  it("shadow mode stores a draft only", async () => {
    repo.setRolloutMode(HP, "shadow");
    const r = router([[call("send_reply", { message: "Draft" })]]);
    const res = await ingestMessage(email(), deps(r));
    expect(res).toMatchObject({ delivered: "draft" });
    expect(sent).toHaveLength(0);
  });

  it("escalations send a holding reply (auto_send) and queue the suggested reply for a human", async () => {
    const r = router(
      [
        [
          call("escalate_to_human", {
            reason: "customer_requested_human",
            summary: "Wants a person about 1042.",
            suggested_reply: "Hi Olivia, I'm on it.",
          }),
        ],
      ],
      { wants_human: true },
    );
    const res = await ingestMessage(email({ text: "Let me talk to a human" }), deps(r));
    expect(res).toMatchObject({ outcome: "escalated", delivered: "sent" });
    expect(sent[0].body).toMatch(/member of our team/);
    expect(store.escalations[0]).toMatchObject({
      reasonCodes: ["customer_requested_human"],
      suggestedReply: "Hi Olivia, I'm on it.",
    });
    expect(store.tickets[0].status).toBe("escalated");
  });

  it("kill switch: nothing is sent, ticket goes to humans", async () => {
    repo.setKillSwitch(HP, true);
    const r = router([[call("send_reply", { message: "x" })]]);
    const res = await ingestMessage(email(), deps(r));
    expect(res).toMatchObject({ outcome: "escalated", delivered: "none" });
    expect(sent).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
  });

  it("rate-limits a sender who floods the inbox", async () => {
    const r = router([[call("send_reply", { message: "ok" })]]);
    const results = [];
    for (let n = 0; n < 8; n++)
      results.push(await ingestMessage(email({ threadKey: `flood-${n}` }), deps(r)));
    expect(results.filter((x) => x.status === "rate_limited").length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(6);
  });

  it("a send failure leaves the ticket in needs_attention (never silently lost)", async () => {
    const r = router([[call("send_reply", { message: "Hello" })]]);
    const res = await ingestMessage(email(), {
      ...deps(r),
      sender: { send: async () => Promise.reject(new Error("smtp down")) },
    });
    expect(res).toMatchObject({ status: "processed", delivered: "none" });
    expect(store.tickets[0].status).toBe("needs_attention");
    expect(store.messages.find((m) => m.direction === "outbound")?.status).toBe("failed");
  });

  // ── Milestone E review regressions ─────────────────────────────────────────────────────────
  it("never emails an unauthenticated sender (no backscatter); the draft waits for a human", async () => {
    const r = router([[call("send_reply", { message: "Our return policy is 30 days." })]]);
    const res = await ingestMessage(
      email({
        from: { email: "victim@third-party.example", name: null },
        auth: { spf: "fail", dkim: "fail", dmarc: "fail", aligned: false },
      }),
      deps(r),
    );
    expect(res).toMatchObject({ status: "processed", delivered: "pending_approval" });
    expect(sent).toHaveLength(0);
    expect(store.escalations[0].reasonCodes).toEqual(["unauthenticated_sender"]);
  });

  it("follow-ups on a human-owned (escalated) ticket are attached without re-running the AI", async () => {
    const r = router(
      [
        [
          call("escalate_to_human", {
            reason: "customer_requested_human",
            summary: "Wants a person please.",
            suggested_reply: "On it.",
          }),
        ],
      ],
      { wants_human: true },
    );
    await ingestMessage(email({ text: "Human please" }), deps(r));
    const callsBefore = r.calls.length;
    const sentBefore = sent.length;
    const res = await ingestMessage(email({ text: "Hello? Anyone?" }), deps(r));
    expect(res.status).toBe("queued_for_human");
    expect(r.calls.length).toBe(callsBefore);
    expect(sent.length).toBe(sentBefore);
    expect(store.escalations).toHaveLength(1);
    expect(store.tickets[0].status).toBe("escalated");
  });

  it("a spam verdict on a follow-up does not close the existing conversation", async () => {
    const first = router([
      [call("send_reply", { message: "Checking.", expects_customer_reply: true })],
    ]);
    await ingestMessage(email({ text: "Where is my order?" }), deps(first));
    expect(store.tickets[0].status).toBe("awaiting_customer");
    await ingestMessage(
      email({ text: "BUY NOW cheap pills" }),
      deps(router([], { intent: "spam" })),
    );
    expect(store.tickets[0].status).not.toBe("closed");
    expect(store.tickets[0].is_spam).not.toBe(true);
  });

  it("a different sender in the same Gmail thread gets a separate ticket (no history leak)", async () => {
    const r = router([[call("send_reply", { message: "ok" })]]);
    await ingestMessage(email({ text: "Olivia's private details" }), deps(r));
    await ingestMessage(
      email({ from: { email: "marcus.lee@example.com", name: null }, text: "What did she say?" }),
      deps(r),
    );
    expect(store.tickets).toHaveLength(2);
    const lastPrompt = JSON.stringify(r.calls.filter((c) => c.tools).at(-1)!.messages);
    expect(lastPrompt).not.toContain("Olivia's private details");
  });

  it("without an email sender configured, nothing is marked as sent", async () => {
    const r = router([[call("send_reply", { message: "Hi" })]]);
    const res = await ingestMessage(email(), { ...deps(r), sender: null });
    expect(res).toMatchObject({ delivered: "none" });
    expect(store.tickets[0].status).toBe("needs_attention");
  });

  it("a message that failed is never re-run automatically (no duplicate replies)", async () => {
    const r = router([[call("send_reply", { message: "Hi" })]]);
    const m = email();
    let failOnce = true;
    const flaky = {
      ...deps(r),
      store: Object.assign(Object.create(store), {
        saveRun: async () => {
          if (failOnce) {
            failOnce = false;
            throw new Error("db down");
          }
          return "run";
        },
      }),
    };
    expect((await ingestMessage(m, flaky)).status).toBe("failed");
    expect(await ingestMessage(m, deps(r))).toEqual({ status: "duplicate" });
    expect(store.tickets[0].status).toBe("needs_attention");
  });
});

describe("Gmail poller", () => {
  it("drains a backlog larger than one cycle instead of re-reading the same messages", async () => {
    const { pollGmail } = await import("@/lib/channels/email/poll");
    const ids = Array.from({ length: 10 }, (_, n) => `m${n}`);
    let historyCalls = 0;
    const gmail = {
      profile: async () => ({ emailAddress: INBOX, historyId: "1" }),
      recentInboxIds: async () => [],
      newMessageIdsSince: async () => ({
        ids: historyCalls++ === 0 ? ids : [],
        historyId: String(10 + historyCalls),
      }),
      getMessage: async (id: string) => ({
        id,
        threadId: `t-${id}`,
        payload: {
          mimeType: "text/plain",
          headers: [
            {
              name: "From",
              value: `visitor-${id}@example.net`,
            } /* distinct senders: isolate the poller from per-sender limits */,
            { name: "Authentication-Results", value: "mx.google.com; dmarc=pass" },
          ],
          body: { data: Buffer.from(`msg ${id}`).toString("base64url") },
        },
      }),
      labelProcessed: async () => {},
    };
    await store.setChannelState(HP, "email", { historyId: "1" });
    const r = router([[call("send_reply", { message: "ok" })]]);
    const seen = new Set<string>();
    for (let cycle = 0; cycle < 3; cycle++) {
      const report = await pollGmail(gmail as never, deps(r), HP);
      report.results.filter((x) => x.status === "processed").forEach((x) => seen.add(x.id));
    }
    expect([...seen].sort()).toEqual([...ids].sort()); // 4 + 4 + 2: everything processed, in order
    expect((await store.channelState(HP, "email")).pending).toEqual([]);
  });
});
