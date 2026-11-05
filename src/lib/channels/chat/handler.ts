import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ingestMessage, type PipelineDeps } from "../../pipeline/ingest.ts";
import type { ChatStore } from "./store.ts";

/**
 * Web chat channel. Security model:
 * - Session ids are random UUIDs wrapped in an HMAC-signed token, so a session can't be guessed
 *   or taken over by changing an id.
 * - Account data/actions require verification: an order number + the email on that order
 *   (max 5 attempts per session, generic failure message so nothing is enumerable).
 * - Per-IP (hashed) and per-session rate limits; optional Cloudflare Turnstile on session start.
 */

export const ChatRequestSchema = z
  .object({
    tenant: z.string().regex(/^[a-z0-9-]{2,40}$/),
    sessionToken: z.string().max(200).optional(),
    message: z.string().trim().min(1).max(2000).optional(),
    verify: z
      .object({ orderNumber: z.string().trim().min(3).max(20), email: z.email() })
      .strict()
      .optional(),
    turnstileToken: z.string().max(4096).optional(),
  })
  .strict()
  .refine((r) => r.message || r.verify, "message or verify is required");
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface ChatResponse {
  sessionToken: string;
  reply: string | null;
  verified: boolean;
  status: "answered" | "with_team" | "verified" | "verify_failed" | "rate_limited" | "closed";
}

export interface ChatDeps {
  pipeline: PipelineDeps;
  chat: ChatStore;
  secret: string;
  verifyTurnstile?: (token: string | undefined, ip: string) => Promise<boolean>;
}

const WITH_TEAM = "Thanks! Your message is with our team — a person will review it and reply here.";
const VERIFY_FAILED =
  "We couldn't verify those details. Please check the order number and the email used for the order.";

export function signSession(id: string, secret: string): string {
  return `${id}.${createHmac("sha256", secret).update(id).digest("base64url").slice(0, 32)}`;
}

export function readSession(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const [id, sig] = token.split(".");
  if (!id || !sig || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const expected = signSession(id, secret).split(".")[1];
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

export const hashIp = (ip: string, secret: string) =>
  createHash("sha256").update(`${secret}:${ip}`).digest("hex").slice(0, 32);

export async function handleChat(
  req: ChatRequest,
  ip: string,
  deps: ChatDeps,
): Promise<ChatResponse | { error: string; status: number }> {
  const tenantId = await deps.pipeline.store.tenantIdBySlug(req.tenant);
  if (!tenantId) return { error: "unknown tenant", status: 404 };
  const ipHash = hashIp(ip, deps.secret);

  if (!(await deps.pipeline.store.rateLimit(`chat-ip:${ipHash}`, 3600, 40))) {
    return { error: "Too many messages — please try again later.", status: 429 };
  }

  // Resume a signed session or start a new one (Turnstile-gated when configured).
  let sessionId = readSession(req.sessionToken, deps.secret);
  let session = sessionId ? await deps.chat.getSession(tenantId, sessionId) : null;
  if (!session) {
    if (deps.verifyTurnstile && !(await deps.verifyTurnstile(req.turnstileToken, ip))) {
      return {
        error:
          "We couldn't confirm you're a person. Tick “Verify you are human” below if it appears, then send your message again.",
        status: 403,
      };
    }
    sessionId = randomUUID();
    session = await deps.chat.createSession(tenantId, sessionId, ipHash);
  }
  const sessionToken = signSession(session.id, deps.secret);

  if (req.verify) {
    const orderNumber = req.verify.orderNumber.replace(/^#/, "").toUpperCase();
    const email = req.verify.email.toLowerCase();
    // Atomic counters (no read-then-write race): 5 tries per session, and 10/day per email and per
    // order number across ALL sessions, so opening new sessions doesn't help a brute-forcer.
    const store = deps.pipeline.store;
    const allowed =
      (await store.rateLimit(`verify-session:${session.id}`, 86_400, 5)) &&
      (await store.rateLimit(`verify-email:${tenantId}:${email}`, 86_400, 10)) &&
      (await store.rateLimit(`verify-order:${tenantId}:${orderNumber}`, 86_400, 10));
    if (!allowed)
      return { sessionToken, reply: VERIFY_FAILED, verified: false, status: "verify_failed" };
    const customerId = await deps.chat.verifyCustomer(tenantId, orderNumber, email);
    if (customerId) await deps.chat.recordVerification(tenantId, session.id, customerId);
    return customerId
      ? {
          sessionToken,
          reply: "Thanks — you're verified. How can I help with your order?",
          verified: true,
          status: "verified",
        }
      : { sessionToken, reply: VERIFY_FAILED, verified: false, status: "verify_failed" };
  }

  if (!(await deps.pipeline.store.rateLimit(`chat-session:${session.id}`, 600, 15))) {
    return {
      sessionToken,
      reply: "You're sending messages quickly — please wait a moment.",
      verified: !!session.verifiedCustomerId,
      status: "rate_limited",
    };
  }

  const email = session.verifiedCustomerId
    ? await deps.chat.customerEmail(tenantId, session.verifiedCustomerId)
    : null;
  const result = await ingestMessage(
    {
      channel: "chat",
      providerMessageId: randomUUID(),
      threadKey: session.id,
      from: { email, name: null },
      to: [],
      subject: "Website chat",
      text: req.message!,
      receivedAt: new Date().toISOString(),
      auth: { spf: "none", dkim: "none", dmarc: "none", aligned: false },
      headers: {},
    },
    deps.pipeline,
    { tenantId, chatVerifiedCustomerId: session.verifiedCustomerId },
  );
  const verified = !!session.verifiedCustomerId;
  if (result.status === "processed") {
    // An escalation's holding reply is "with team", not an answer.
    if (result.outcome === "escalated")
      return { sessionToken, reply: WITH_TEAM, verified, status: "with_team" };
    if (result.delivered === "sent" && result.reply)
      return { sessionToken, reply: result.reply, verified, status: "answered" };
    if (result.outcome === "closed_no_reply")
      return { sessionToken, reply: null, verified, status: "closed" };
    return { sessionToken, reply: WITH_TEAM, verified, status: "with_team" };
  }
  if (result.status === "rate_limited")
    return {
      sessionToken,
      reply: "You're sending messages quickly — please wait a moment.",
      verified,
      status: "rate_limited",
    };
  return { sessionToken, reply: WITH_TEAM, verified, status: "with_team" };
}
