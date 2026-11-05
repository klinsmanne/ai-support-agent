import { markdownToPlainText } from "../../text/markdown.ts";
import type { OutboundReply } from "../types.ts";

/**
 * Builds an RFC 5322 reply. Threading: In-Reply-To + References + "Re:" subject (Gmail also
 * needs the threadId at send time). Loop safety: Auto-Submitted: auto-replied tells other
 * well-behaved autoresponders not to answer us.
 */
export function composeReplyMime(
  reply: OutboundReply,
  from: { email: string; name: string },
  /** stripMarkdown: model-written replies only; system emails (alerts, sign-in links) go as is. */
  opts: { isReply?: boolean; stripMarkdown?: boolean } = {},
): string {
  const isReply = opts.isReply ?? true;
  const subject = !isReply
    ? (reply.subject ?? "")
    : reply.subject
      ? /^re:/i.test(reply.subject)
        ? reply.subject
        : `Re: ${reply.subject}`
      : "Re: your request";
  const headers = [
    `From: ${encodeHeader(from.name)} <${from.email}>`,
    `To: ${reply.to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-replied",
    "X-Auto-Response-Suppress: All",
    ...(reply.inReplyTo ? [`In-Reply-To: ${reply.inReplyTo}`] : []),
    ...(reply.inReplyTo || reply.references
      ? [`References: ${[reply.references, reply.inReplyTo].filter(Boolean).join(" ").trim()}`]
      : []),
  ];
  // Header injection guard: no CR/LF may survive inside a header value.
  for (const h of headers)
    if (/[\r\n]/.test(h)) throw new Error("header injection attempt blocked");
  const text = (opts.stripMarkdown ?? true) ? markdownToPlainText(reply.body) : reply.body;
  const body = Buffer.from(text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** RFC 2047 encoded-word for non-ASCII header text (e.g. "Re: ¿Dónde está mi pedido?"). */
function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7E]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
