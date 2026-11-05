import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../types";
import { markdownToPlainText } from "../../text/markdown";
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
  auth: { spf: "pass", dkim: "pass", dmarc: "pass", aligned: true },
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
    expect(parsed.auth).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass", aligned: true });
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
      aligned: false,
    });
    expect(parseAuthenticationResults("")).toEqual({
      spf: "unknown",
      dkim: "unknown",
      dmarc: "unknown",
      aligned: false,
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

describe("sender authentication (security review)", () => {
  const google = (rest: string) => `mx.google.com; ${rest}`;
  it("spf+dkim passing for the ATTACKER's domain does not authenticate a spoofed From", () => {
    const auth = parseAuthenticationResults(
      google(
        "dkim=pass header.i=@evil.example header.s=s1; spf=pass smtp.mailfrom=bounce@evil.example; dmarc=fail header.from=customer.example",
      ),
      "victim@customer.example",
    );
    expect(auth.aligned).toBe(false);
  });

  it("aligned DKIM or SPF (same or sub-domain) authenticates even without DMARC", () => {
    expect(
      parseAuthenticationResults(
        google("dkim=pass header.d=customer.example; spf=none"),
        "a@customer.example",
      ).aligned,
    ).toBe(true);
    expect(
      parseAuthenticationResults(
        google("spf=pass smtp.mailfrom=bounces@mail.customer.example"),
        "a@customer.example",
      ).aligned,
    ).toBe(true);
  });

  it("ignores Authentication-Results headers the sender forged", () => {
    const parsed = parseGmailMessage({
      id: "x",
      threadId: "y",
      payload: {
        mimeType: "text/plain",
        headers: [
          {
            name: "Authentication-Results",
            value: "mx.google.com; spf=softfail smtp.mailfrom=evil.example",
          },
          {
            name: "Authentication-Results",
            value: "mx.google.com; dmarc=pass header.from=customer.example",
          }, // attacker-added, lower
          { name: "Authentication-Results", value: "evil.example; dkim=pass; dmarc=pass" },
          { name: "From", value: "victim@customer.example" },
        ],
        body: { data: b64("Refund me") },
      },
    });
    expect(parsed.auth).toMatchObject({ dmarc: "unknown", aligned: false });
  });

  it("keeps only the first Message-ID / References (duplicates can't break replies)", () => {
    const parsed = parseGmailMessage({
      id: "x",
      threadId: "y",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "a@b.com" },
          { name: "Message-ID", value: "<one@x>" },
          { name: "Message-ID", value: "<two@x>" },
        ],
        body: { data: b64("hi") },
      },
    });
    expect(parsed.headers["message-id"]).toBe("<one@x>");
  });

  it("strips Gmail's two-line wrapped attribution (live finding)", () => {
    expect(
      stripQuotedReply(
        "human\n\nOn Wed, Nov 4, 2026 at 9:32 AM Customer Support <\nintegralplantsupport@gmail.com> wrote:\n> Thanks for your message",
      ),
    ).toBe("human");
  });

  it("keeps bottom-posted replies", () => {
    expect(
      stripQuotedReply(
        "On Mon, Nov 2, 2026 Support wrote:\n> Your order shipped\n\nThanks, but it still hasn't arrived.",
      ),
    ).toBe("Thanks, but it still hasn't arrived.");
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

  it("does not drop ordinary Outlook mail carrying X-Auto-Response-Suppress", () => {
    expect(emailSkipReason(msg({ "x-auto-response-suppress": "All" }), [INBOX])).toBeNull();
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

describe("markdownToPlainText (live test: emails showed raw **)", () => {
  it("strips emphasis, headings and code marks, keeps bullets and link targets", () => {
    expect(
      markdownToPlainText(
        "## Returns\n**Return policy for sale items**\n• Final sale items *unless* damaged\n* bullet stays\nUse `code` and [the policy](https://hp.example/returns).",
      ),
    ).toBe(
      "Returns\nReturn policy for sale items\n• Final sale items unless damaged\n* bullet stays\nUse code and the policy (https://hp.example/returns).",
    );
  });

  it("leaves identifiers, globs and multiplication alone (code-quality review)", () => {
    for (const text of [
      "snake__case__name",
      "a/*.txt and b/*.md",
      "5 * 3 = 15",
      "first_name@example.com",
      "x**2** = 4",
    ])
      expect(markdownToPlainText(text), text).toBe(text);
    expect(markdownToPlainText("***both***")).toBe("both");
  });

  it("system emails (alerts, sign-in links) are sent exactly as written", () => {
    const raw = composeReplyMime(
      {
        channel: "email",
        threadKey: "",
        to: "owner@example.com",
        subject: "Alert",
        body: "err **x**",
      },
      { email: "support@example.com", name: "Support" },
      { isReply: false, stripMarkdown: false },
    );
    const body = Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString();
    expect(body).toBe("err **x**");
  });

  it("leaves plain text, prices and math untouched", () => {
    const text = 'Total: $49.00 for 2 x 3 items, 5 * 3 = 15. Reply "human" anytime.';
    expect(markdownToPlainText(text)).toBe(text);
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

describe("GmailClient.newMessageIdsSince", () => {
  it("picks up new mail and mail moved into the inbox (e.g. 'Not spam'), never our sent mail", async () => {
    const { GmailClient } = await import("./gmail-client");
    const fakeFetch = (async (url: string) => {
      if (String(url).includes("oauth2"))
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      expect(String(url)).toContain("historyTypes=messageAdded");
      expect(String(url)).toContain("historyTypes=labelAdded");
      return new Response(
        JSON.stringify({
          historyId: "200",
          history: [
            {
              messagesAdded: [
                { message: { id: "new", labelIds: ["INBOX"] } },
                { message: { id: "ours", labelIds: ["SENT"] } },
              ],
            },
            {
              labelsAdded: [
                { message: { id: "unspammed", labelIds: ["INBOX"] }, labelIds: ["INBOX"] },
              ],
            },
            {
              labelsAdded: [
                {
                  message: { id: "starred", labelIds: ["INBOX", "STARRED"] },
                  labelIds: ["STARRED"],
                },
              ],
            },
          ],
        }),
      );
    }) as typeof fetch;
    const client = new GmailClient(
      { clientId: "c", clientSecret: "s", refreshToken: "r", address: INBOX, displayName: "S" },
      fakeFetch,
    );
    expect(await client.newMessageIdsSince("100")).toEqual({
      ids: ["new", "unspammed"],
      historyId: "200",
    });
  });
});
