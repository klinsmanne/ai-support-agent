import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../types";
import { composeReplyMime } from "./compose";
import { baseAddress, emailSkipReason, plusTag } from "./filters";
import {
  parseAddress,
  parseAuthenticationResults,
  parseGmailMessage,
  stripQuotedReply,
} from "./parse";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const INBOX = "integralplantsupport@gmail.com";

const msg = (
  headers: Record<string, string>,
  text = "Where is my order?",
  from = "olivia.bennett@example.com",
): InboundMessage => ({
  channel: "email",
  providerMessageId: "m1",
  threadKey: "t1",
  from: { email: from, name: null },
  to: [INBOX],
  subject: "Order question",
  text,
  receivedAt: new Date().toISOString(),
  auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
  headers,
});

describe("parseGmailMessage", () => {
  it("extracts sender, recipients, text (quoted history removed) and auth results", () => {
    const parsed = parseGmailMessage({
      id: "abc",
      threadId: "thr",
      internalDate: "1793700000000",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: '"Olivia Bennett" <Olivia.Bennett@Example.com>' },
          { name: "To", value: `Harbor Support <${INBOX}>` },
          { name: "Subject", value: "Re: Order 1042" },
          { name: "Message-ID", value: "<CAF123@mail.gmail.com>" },
          {
            name: "Authentication-Results",
            value:
              "mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass (p=NONE) header.from=example.com",
          },
        ],
        parts: [
          {
            mimeType: "text/plain",
            body: {
              data: b64(
                "Still not here!\n\nOn Mon, Nov 2, 2026 at 9:00 AM Support wrote:\n> Your order is delayed",
              ),
            },
          },
          { mimeType: "text/html", body: { data: b64("<p>Still not here!</p>") } },
        ],
      },
    });
    expect(parsed.from).toEqual({ email: "olivia.bennett@example.com", name: "Olivia Bennett" });
    expect(parsed.to).toEqual([INBOX]);
    expect(parsed.text).toBe("Still not here!");
    expect(parsed.auth).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
    expect(parsed.threadKey).toBe("thr");
    expect(parsed.headers["message-id"]).toBe("<CAF123@mail.gmail.com>");
  });

  it("falls back to HTML when there is no plain-text part", () => {
    const parsed = parseGmailMessage({
      id: "x",
      threadId: "y",
      payload: {
        mimeType: "text/html",
        headers: [{ name: "From", value: "a@b.com" }],
        body: { data: b64("<div>Hi<br>there</div><script>evil()</script>") },
      },
    });
    expect(parsed.text).toBe("Hi\nthere");
  });

  it("parses failing and missing authentication", () => {
    expect(parseAuthenticationResults("spf=softfail; dkim=none; dmarc=fail")).toEqual({
      spf: "fail",
      dkim: "none",
      dmarc: "fail",
    });
    expect(parseAuthenticationResults("")).toEqual({
      spf: "unknown",
      dkim: "unknown",
      dmarc: "unknown",
    });
  });

  it("parses addresses and rejects junk", () => {
    expect(parseAddress("not an address").email).toBeNull();
    expect(parseAddress("<A@B.co>").email).toBe("a@b.co");
  });

  it("strips Spanish and French quoted replies", () => {
    expect(
      stripQuotedReply("Gracias\n\nEl lun, 2 nov 2026 a las 9:00, Soporte escribió:\n> hola"),
    ).toBe("Gracias");
    expect(stripQuotedReply("Merci\nLe lun. 2 nov. 2026, Support a écrit :\n> bonjour")).toBe(
      "Merci",
    );
  });
});

describe("emailSkipReason (loop prevention)", () => {
  it.each([
    ["own address", msg({}, "hi", INBOX), "own_address"],
    [
      "own address with +tag",
      msg({}, "hi", "integralplantsupport+cadence@gmail.com"),
      "own_address",
    ],
    ["no-reply sender", msg({}, "hi", "no-reply@shop.example"), "no_reply_sender"],
    ["mailer-daemon bounce", msg({}, "hi", "mailer-daemon@googlemail.com"), "bounce"],
    ["Auto-Submitted header", msg({ "auto-submitted": "auto-replied" }), "auto_submitted"],
    ["X-Autoreply header", msg({ "x-autoreply": "yes" }), "auto_reply_header"],
    ["mailing list", msg({ "list-id": "<news.shop.example>" }), "mailing_list"],
    ["bulk precedence", msg({ precedence: "bulk" }), "bulk_precedence"],
    [
      "delivery report",
      msg({ "content-type": "multipart/report; report-type=delivery-status" }),
      "bounce",
    ],
    [
      "out-of-office subject",
      { ...msg({}), subject: "Out of Office: back Monday" },
      "auto_reply_header",
    ],
    ["empty body", msg({}, "   "), "empty_body"],
  ])("skips %s", (_label, m, reason) => {
    expect(emailSkipReason(m as InboundMessage, [INBOX])).toBe(reason);
  });

  it("does not skip a normal customer email", () => {
    expect(emailSkipReason(msg({ "auto-submitted": "no" }), [INBOX])).toBeNull();
  });

  it("routes tenants by +tag", () => {
    expect(plusTag(["integralplantsupport+cadence@gmail.com"], INBOX)).toBe("cadence");
    expect(plusTag([INBOX], INBOX)).toBeNull();
    expect(baseAddress("A+x@B.com")).toBe("a@b.com");
  });
});

describe("composeReplyMime", () => {
  const reply = {
    channel: "email" as const,
    threadKey: "t",
    to: "olivia.bennett@example.com",
    subject: "¿Dónde está mi pedido?",
    body: "Hola",
    inReplyTo: "<abc@x>",
    references: "<root@x>",
  };

  it("threads the reply and marks it auto-replied (loop safety)", () => {
    const raw = composeReplyMime(reply, { email: INBOX, name: "Harbor & Pine Support" });
    expect(raw).toMatch(/^From: Harbor & Pine Support <integralplantsupport@gmail\.com>/);
    expect(raw).toContain("In-Reply-To: <abc@x>");
    expect(raw).toContain("References: <root@x> <abc@x>");
    expect(raw).toContain("Auto-Submitted: auto-replied");
    expect(raw).toContain("Subject: =?UTF-8?B?"); // non-ASCII subject encoded
  });

  it("blocks header injection through the recipient", () => {
    expect(() =>
      composeReplyMime(
        { ...reply, to: "a@b.com\r\nBcc: victim@x.com" },
        { email: INBOX, name: "S" },
      ),
    ).toThrow(/header injection/);
  });
});
