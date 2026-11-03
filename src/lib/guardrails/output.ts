/**
 * Validates every outbound reply before it can be sent (OWASP LLM02 / LLM05 / LLM07).
 * Deterministic checks only — no model in the loop — so a compromised or confused model can't
 * talk its way past them.
 */

export interface ReplyContext {
  /** Random marker embedded in the system prompt; seeing it in output means a prompt leak. */
  canary: string;
  customerEmail?: string | null;
  supportEmail?: string | null;
  allowedLinkDomains: string[];
  /** Internal identifiers (UUIDs etc.) that must never be shown to customers. */
  internalIds: string[];
  maxLength?: number;
}

export interface ReplyVerdict {
  ok: boolean;
  violations: string[];
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI/Anthropic-style keys
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bgsk_[A-Za-z0-9]{20,}/, // Groq
  /\bsb_secret_[A-Za-z0-9_-]{10,}/, // Supabase secret
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const SYSTEM_PROMPT_MARKERS = [
  /untrusted_customer_message/i,
  /PROMPT_VERSION/i,
  /\bNON-NEGOTIABLE RULES\b/i,
];
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\bhttps?:\/\/([^\s/)>\]]+)[^\s)>\]]*/gi;

export function validateReply(reply: string, ctx: ReplyContext): ReplyVerdict {
  const violations: string[] = [];
  const text = reply.normalize("NFKC");

  if (!text.trim()) violations.push("empty_reply");
  if (text.length > (ctx.maxLength ?? 4000)) violations.push("reply_too_long");
  if (ctx.canary && text.includes(ctx.canary)) violations.push("system_prompt_leak:canary");
  if (SYSTEM_PROMPT_MARKERS.some((m) => m.test(text))) violations.push("system_prompt_leak:marker");
  if (SECRET_PATTERNS.some((p) => p.test(text))) violations.push("secret_detected");
  if (UUID.test(text) || ctx.internalIds.some((id) => id && text.includes(id)))
    violations.push("internal_id_exposed");

  const allowedEmails = new Set(
    [ctx.customerEmail, ctx.supportEmail].filter(Boolean).map((e) => e!.toLowerCase()),
  );
  for (const email of text.match(EMAIL) ?? []) {
    if (!allowedEmails.has(email.toLowerCase())) {
      violations.push("foreign_email_exposed");
      break;
    }
  }

  for (const match of text.matchAll(URL_RE)) {
    // Sentence punctuation right after a URL ("…carrier.com.") is not part of the host.
    const host = match[1]
      .toLowerCase()
      .split(":")[0]
      .replace(/[.,;!?]+$/, "");
    const allowed = ctx.allowedLinkDomains.some((d) => host === d || host.endsWith(`.${d}`));
    if (!allowed) {
      violations.push(`unapproved_link:${host}`);
    }
  }

  return { ok: violations.length === 0, violations };
}
