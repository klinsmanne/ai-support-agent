import type { InboundMessage, SenderAuth } from "../types.ts";

/** Subset of the Gmail API message resource (format=full) that we use. */
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}
interface GmailPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

const MAX_TEXT = 20_000;

export function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Converts a Gmail API message into a normalized InboundMessage. */
export function parseGmailMessage(msg: GmailMessage): InboundMessage {
  // First value wins: duplicated Message-ID/References headers can't break threading or compose.
  const headers: Record<string, string> = {};
  const authResults: string[] = [];
  for (const h of msg.payload?.headers ?? []) {
    const key = h.name.toLowerCase();
    if (key === "authentication-results") authResults.push(h.value);
    headers[key] ??= h.value.replace(/[\r\n]+/g, " ");
  }
  const from = parseAddress(headers["from"] ?? "");
  const to = [headers["to"], headers["cc"], headers["delivered-to"]]
    .filter(Boolean)
    .flatMap((v) => v!.split(","))
    .map((v) => parseAddress(v).email)
    .filter((e): e is string => !!e);

  return {
    channel: "email",
    providerMessageId: msg.id,
    threadKey: msg.threadId,
    from,
    to: [...new Set(to)],
    subject: headers["subject"] ?? null,
    text: stripQuotedReply(extractText(msg.payload)).slice(0, MAX_TEXT),
    receivedAt: new Date(Number(msg.internalDate ?? Date.now())).toISOString(),
    auth: parseAuthenticationResults(trustedAuthResults(authResults), from.email),
    headers,
  };
}

/** "Olivia Bennett <Olivia@Example.com>" → { name, email (lower-case) } */
export function parseAddress(value: string): { email: string | null; name: string | null } {
  const angle = /<([^>]+)>/.exec(value);
  const email = (angle?.[1] ?? value).trim().toLowerCase();
  const name = angle ? value.slice(0, angle.index).replace(/["']/g, "").trim() || null : null;
  return { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null, name };
}

function extractText(part?: GmailPart): string {
  if (!part) return "";
  const plain = findPart(part, "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);
  const html = findPart(part, "text/html");
  if (html?.body?.data) return htmlToText(decodeBase64Url(html.body.data));
  return part.body?.data ? decodeBase64Url(part.body.data) : "";
}

function findPart(part: GmailPart, mime: string): GmailPart | undefined {
  if (part.mimeType === mime && part.body?.data) return part;
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return undefined;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Removes quoted history so each ticket message holds only what the customer just wrote. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const ATTRIBUTION = /^(On .+ wrote:|El .+ escribió:|Le .+ a écrit\s*:)\s*$/;
  // Gmail often wraps the attribution over two lines ("On …, Support <" / "x@y.com> wrote:").
  const attributionAt = (i: number) =>
    ATTRIBUTION.test(lines[i]) ||
    (/^(On|El|Le) /.test(lines[i]) &&
      i + 1 < lines.length &&
      ATTRIBUTION.test(`${lines[i]} ${lines[i + 1]}`));
  const out: string[] = [];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      attributionAt(i) ||
      /^-{2,}\s*Original Message\s*-{2,}/i.test(line) ||
      /^_{5,}/.test(line) ||
      (/^From: .+/.test(line) && out.length > 0)
    ) {
      cut = i;
      break;
    }
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  const top = out.join("\n").trim();
  if (top) return top;
  // Bottom-posted reply (quote first, answer below): keep the non-quoted lines after the quote.
  return lines
    .slice(cut)
    .filter(
      (l, i, arr) =>
        !l.startsWith(">") &&
        !ATTRIBUTION.test(l) &&
        !(i + 1 < arr.length && ATTRIBUTION.test(`${l} ${arr[i + 1]}`)) &&
        !(i > 0 && ATTRIBUTION.test(`${arr[i - 1]} ${l}`)),
    )
    .join("\n")
    .trim();
}

/**
 * Only the receiving server's own Authentication-Results header can be trusted: Gmail prepends it,
 * so it is the topmost one with authserv-id `mx.google.com`. Any copy an attacker adds lower down
 * (e.g. a fake "dmarc=pass") is ignored.
 */
export function trustedAuthResults(headers: string[], authservId = "mx.google.com"): string {
  return headers.find((h) => h.split(";")[0].trim().toLowerCase() === authservId) ?? "";
}

/** Parses SPF/DKIM/DMARC verdicts and whether they authenticate the From domain itself. */
export function parseAuthenticationResults(
  header: string,
  fromEmail: string | null = null,
): SenderAuth {
  const get = (method: string): SenderAuth["spf"] => {
    const m = new RegExp(
      `\\b${method}=(pass|fail|softfail|neutral|none|temperror|permerror)`,
      "i",
    ).exec(header);
    if (!m) return "unknown";
    const v = m[1].toLowerCase();
    return v === "pass" ? "pass" : v === "none" ? "none" : "fail";
  };
  const spf = get("spf");
  const dkim = get("dkim");
  const dmarc = get("dmarc");
  const fromDomain = fromEmail?.split("@")[1]?.toLowerCase() ?? null;
  const dkimDomain = /\bdkim=pass[^;]*?header\.(?:d=|i=[^@\s;]*@)([a-z0-9.-]+)/i.exec(header)?.[1];
  const spfDomain = /\bspf=pass[^;]*?smtp\.mailfrom=(?:[^@\s;]*@)?([a-z0-9.-]+)/i.exec(header)?.[1];
  // Relaxed alignment (RFC 7489): same domain or a subdomain of the From domain.
  const aligns = (d?: string) =>
    !!d &&
    !!fromDomain &&
    (d.toLowerCase() === fromDomain ||
      d.toLowerCase().endsWith(`.${fromDomain}`) ||
      fromDomain.endsWith(`.${d.toLowerCase()}`));
  const aligned =
    dmarc === "pass" ||
    (dkim === "pass" && aligns(dkimDomain)) ||
    (spf === "pass" && aligns(spfDomain));
  return { spf, dkim, dmarc, aligned };
}
