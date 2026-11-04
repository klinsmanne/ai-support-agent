import type { InboundMessage } from "../types.ts";

/**
 * Email loop prevention and noise filtering (runs before any model call, costs nothing).
 * Never reply to: our own address, no-reply senders, auto-replies, bounces, mailing lists,
 * bulk mail. Each rule returns a reason that is recorded on the closed ticket.
 */
export type SkipReason =
  | "own_address"
  | "no_sender"
  | "no_reply_sender"
  | "auto_submitted"
  | "auto_reply_header"
  | "bounce"
  | "mailing_list"
  | "bulk_precedence"
  | "empty_body";

// Note: X-Auto-Response-Suppress is NOT an auto-reply signal — Outlook adds it to ordinary mail.
export function emailSkipReason(msg: InboundMessage, ownAddresses: string[]): SkipReason | null {
  const h = msg.headers;
  const from = msg.from.email;
  const own = ownAddresses.map((a) => baseAddress(a));

  if (!from) return "no_sender";
  if (own.includes(baseAddress(from))) return "own_address";
  if (
    /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)([+._-].*)?@/i.test(
      from,
    )
  ) {
    return /mailer-daemon|postmaster|bounce/i.test(from) ? "bounce" : "no_reply_sender";
  }
  if (h["auto-submitted"] && !/^no$/i.test(h["auto-submitted"].trim())) return "auto_submitted";
  if (h["x-autoreply"] || h["x-autorespond"] || /^auto[-_ ]?reply/i.test(h["x-mailer"] ?? "")) {
    return "auto_reply_header";
  }
  if (
    /multipart\/report|delivery-status/i.test(h["content-type"] ?? "") ||
    h["return-path"]?.trim() === "<>"
  ) {
    return "bounce";
  }
  if (h["list-id"] || h["list-unsubscribe"] || h["list-post"]) return "mailing_list";
  if (/^(bulk|list|junk)$/i.test((h["precedence"] ?? "").trim())) return "bulk_precedence";
  if (
    /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|respuesta automática|réponse automatique)/i.test(
      msg.subject ?? "",
    )
  ) {
    return "auto_reply_header";
  }
  if (!msg.text.trim()) return "empty_body";
  return null;
}

/** Strips +tags so support+cadence@x and support@x compare equal. */
export function baseAddress(email: string): string {
  const [local, domain] = email.toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

/** Returns the +tag of the first recipient on our inbox (tenant routing), e.g. "cadence". */
export function plusTag(recipients: string[], inbox: string): string | null {
  const target = baseAddress(inbox);
  for (const r of recipients) {
    if (baseAddress(r) === target) {
      const tag = r.toLowerCase().split("@")[0].split("+")[1];
      if (tag) return tag;
    }
  }
  return null;
}
