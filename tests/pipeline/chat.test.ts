import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRepo } from "@/lib/agent/memory-repo";
import {
  handleChat,
  readSession,
  signSession,
  type ChatDeps,
  type ChatResponse,
} from "@/lib/channels/chat/handler";
import { MemoryChatStore } from "@/lib/channels/chat/store";
import type { GenerateRequest, ToolCall } from "@/lib/llm/types";
import { MemoryStore } from "@/lib/pipeline/memory-store";
import { loadTenantFolders } from "@/lib/tenants/load";

const tenants = loadTenantFolders(join(import.meta.dirname, "..", "..", "tenants"));
const HP = MemoryRepo.tenantId("harbor-pine");
const SECRET = "x".repeat(40);
const call = (name: string, args: unknown = {}): ToolCall => ({
  id: `${name}-${Math.random()}`,
  name,
  arguments: args,
});

let repo: MemoryRepo;
let deps: ChatDeps;
let seenSystemPrompts: string[];

beforeEach(() => {
  repo = new MemoryRepo(tenants);
  seenSystemPrompts = [];
  const steps: ToolCall[][] = [
    [call("get_orders", { order_number: "1042" })],
    [call("send_reply", { message: "Your order is delayed." })],
  ];
  let i = 0;
  deps = {
    secret: SECRET,
    chat: new MemoryChatStore(repo),
    pipeline: {
      store: new MemoryStore(repo, { "harbor-pine": HP }),
      repo,
      sender: null,
      inboxAddress: "integralplantsupport@gmail.com",
      defaultTenantSlug: "harbor-pine",
      router: {
        async generate(req: GenerateRequest) {
          const base = {
            provider: "mock" as const,
            model: "m",
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 1,
          };
          if (req.responseSchema) {
            return {
              result: {
                ...base,
                finishReason: "stop" as const,
                toolCalls: [],
                text: JSON.stringify({
                  intent: "order_status",
                  urgency: "normal",
                  sentiment: 0,
                  language: "en",
                  wants_human: false,
                  injection_attempt: false,
                  order_numbers: ["1042"],
                  confidence: 0.9,
                  summary: "s",
                }),
              },
              attempts: [],
            };
          }
          seenSystemPrompts.push(req.system);
          return {
            result: {
              ...base,
              finishReason: "tool_calls" as const,
              text: "",
              toolCalls: steps[Math.min(i++, steps.length - 1)],
            },
            attempts: [],
          };
        },
      },
    },
  };
});

const ok = (r: Awaited<ReturnType<typeof handleChat>>) => {
  if ("error" in r) throw new Error(r.error);
  return r as ChatResponse;
};

describe("chat sessions", () => {
  it("signs session ids and rejects tampered or forged tokens", () => {
    const id = "5f7886d2-4618-47ad-92d8-239f1856c75f";
    const token = signSession(id, SECRET);
    expect(readSession(token, SECRET)).toBe(id);
    expect(
      readSession(
        token.replace(/.$/, (c) => (c === "A" ? "B" : "A")),
        SECRET,
      ),
    ).toBeNull();
    expect(readSession(`${id}.forged`, SECRET)).toBeNull();
    expect(readSession(signSession(id, "other-secret".repeat(4)), SECRET)).toBeNull();
  });

  it("unverified visitors get general help only; verified ones can look up their order", async () => {
    const first = ok(
      await handleChat({ tenant: "harbor-pine", message: "Where is order 1042?" }, "1.1.1.1", deps),
    );
    expect(first.verified).toBe(false);
    expect(seenSystemPrompts.at(-1)).toMatch(/Sender verified: NO/);

    const verify = ok(
      await handleChat(
        {
          tenant: "harbor-pine",
          sessionToken: first.sessionToken,
          verify: { orderNumber: "#1042", email: "Olivia.Bennett@example.com" },
        },
        "1.1.1.1",
        deps,
      ),
    );
    expect(verify).toMatchObject({ verified: true, status: "verified" });

    const after = ok(
      await handleChat(
        {
          tenant: "harbor-pine",
          sessionToken: first.sessionToken,
          message: "Where is order 1042?",
        },
        "1.1.1.1",
        deps,
      ),
    );
    expect(after.verified).toBe(true);
    expect(seenSystemPrompts.at(-1)).toMatch(/Sender verified: yes/);
  });

  it("verification fails with a generic message and locks after 5 attempts", async () => {
    const s = ok(
      await handleChat(
        { tenant: "harbor-pine", verify: { orderNumber: "1042", email: "attacker@evil.example" } },
        "2.2.2.2",
        deps,
      ),
    );
    expect(s.status).toBe("verify_failed");
    for (let n = 0; n < 5; n++) {
      await handleChat(
        {
          tenant: "harbor-pine",
          sessionToken: s.sessionToken,
          verify: { orderNumber: "1042", email: "attacker@evil.example" },
        },
        "2.2.2.2",
        deps,
      );
    }
    // Even the correct details are refused once the attempt budget is spent.
    const locked = ok(
      await handleChat(
        {
          tenant: "harbor-pine",
          sessionToken: s.sessionToken,
          verify: { orderNumber: "1042", email: "olivia.bennett@example.com" },
        },
        "2.2.2.2",
        deps,
      ),
    );
    expect(locked).toMatchObject({ verified: false, status: "verify_failed" });
  });

  it("an order number with someone else's email does not verify (no cross-customer access)", async () => {
    const r = ok(
      await handleChat(
        {
          tenant: "harbor-pine",
          verify: { orderNumber: "1051", email: "olivia.bennett@example.com" },
        },
        "3.3.3.3",
        deps,
      ),
    );
    expect(r.verified).toBe(false);
  });

  it("rejects unknown tenants and enforces the bot check when configured", async () => {
    expect(await handleChat({ tenant: "nope", message: "hi" }, "4.4.4.4", deps)).toMatchObject({
      status: 404,
    });
    const guarded = { ...deps, verifyTurnstile: async (t?: string) => t === "good" };
    expect(
      await handleChat({ tenant: "harbor-pine", message: "hi" }, "4.4.4.4", guarded),
    ).toMatchObject({ status: 403 });
    expect(
      "sessionToken" in
        (await handleChat(
          { tenant: "harbor-pine", message: "hi", turnstileToken: "good" },
          "4.4.4.4",
          guarded,
        )),
    ).toBe(true);
  });
});
