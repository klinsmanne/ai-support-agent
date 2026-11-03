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
  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    const key = h.name.toLowerCase();
    headers[key] = headers[key] ? `${headers[key]}\n${h.value}` : h.value;
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
    auth: parseAuthenticationResults(headers["authentication-results"] ?? ""),
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
  const out: string[] = [];
  for (const line of lines) {
    if (
      /^On .+ wrote:\s*$/.test(line) ||
      /^El .+ escribió:\s*$/.test(line) ||
      /^Le .+ a écrit\s*:\s*$/.test(line)
    )
      break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^_{5,}/.test(line)) break;
    if (/^From: .+/.test(line) && out.length > 0) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Parses SPF/DKIM/DMARC verdicts that the receiving server (Gmail) recorded. */
export function parseAuthenticationResults(header: string): SenderAuth {
  const get = (method: string): SenderAuth["spf"] => {
    const m = new RegExp(
      `\\b${method}=(pass|fail|softfail|neutral|none|temperror|permerror)`,
      "i",
    ).exec(header);
    if (!m) return "unknown";
    const v = m[1].toLowerCase();
    return v === "pass" ? "pass" : v === "none" ? "none" : "fail";
  };
  return { spf: get("spf"), dkim: get("dkim"), dmarc: get("dmarc") };
}
