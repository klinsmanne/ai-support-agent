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

  for (const problem of linkProblems(text, ctx.allowedLinkDomains)) violations.push(problem);

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

/** Any scheme other than https is blocked outright (javascript:, data:, http:, ftp:, mailto: …). */
const SCHEME = /\b([a-z][a-z0-9+.-]{1,15}):(?=\/\/|[^\s\d])/gi;
const BLOCKED_SCHEMES = new Set([
  "http",
  "javascript",
  "data",
  "vbscript",
  "file",
  "ftp",
  "blob",
  "mailto",
  "tel",
  "sms",
]);
/** Markdown link targets: [text](target) */
const MD_TARGET = /\]\(\s*<?([^)\s>]+)/g;
/** Protocol-relative links: //host/path */
const PROTO_RELATIVE = /(?:^|[\s("'<[])\/\/([^\s/?#)>\]]+)/g;
/** Bare domains such as www.evil.com or evil.com/login (TLD of 2+ letters). */
const BARE_DOMAIN =
  /(?:^|[^\w@./-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[/:?#]|[\s)>\],;!"']|\.(?:\s|$)|$)/gi;

/**
 * Finds every link-like thing in the reply and checks its parsed hostname against the allowlist.
 * Parsing with URL() means "https://evil.com?.allowed.com" resolves to host evil.com.
 */
function linkProblems(text: string, allowedDomains: string[]): string[] {
  const problems: string[] = [];
  const allowedHost = (host: string) =>
    allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
  const checkHost = (raw: string) => {
    const host = raw.toLowerCase().replace(/[.,;!?]+$/, "");
    if (!allowedHost(host)) problems.push(`unapproved_link:${host}`);
  };

  for (const m of text.matchAll(SCHEME)) {
    const scheme = m[1].toLowerCase();
    // Only https links may reach customers; plain http, javascript:, data: etc. are refused.
    if (scheme !== "https" && BLOCKED_SCHEMES.has(scheme))
      problems.push(`blocked_scheme:${scheme}`);
  }
  for (const m of text.matchAll(/\bhttps:\/\/[^\s<>"')\]]+/gi)) {
    try {
      checkHost(new URL(m[0].replace(/[.,;!?]+$/, "")).hostname);
    } catch {
      problems.push("malformed_link");
    }
  }
  for (const m of text.matchAll(MD_TARGET)) {
    const target = m[1];
    if (/^https:\/\//i.test(target)) continue; // already checked above
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // scheme handled above
    try {
      checkHost(
        new URL(target.startsWith("//") ? `https:${target}` : `https://${target}`).hostname,
      );
    } catch {
      problems.push("malformed_link");
    }
  }
  for (const m of text.matchAll(PROTO_RELATIVE)) checkHost(m[1]);
  for (const m of text.matchAll(BARE_DOMAIN)) {
    const host = m[1];
    // Skip hosts that are part of an https URL or email (already handled) and plain file names.
    if (/\.(md|txt|pdf|png|jpg|jpeg|csv|json)$/i.test(host)) continue;
    checkHost(host);
  }
  return problems;
}
