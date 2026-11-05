import { describe, expect, it, vi } from "vitest";
import {
  buildDigest,
  notifyUrgentEscalation,
  reasonLabel,
  URGENT_PER_HOUR,
} from "./escalation-notify";

const store = (allowed = true) => ({ rateLimit: vi.fn().mockResolvedValue(allowed) });
const base = {
  tenantId: "t1",
  brand: "Harbor & Pine",
  to: "team@client.example",
  ticketId: "tk1",
  summary: "Olivia (olivia.bennett@example.com) asked for a person about order 1042",
  ticketUrl: "https://app.example/dashboard/tickets/tk1",
};

describe("urgent escalation notifications", () => {
  it("emails the team for an urgent reason, with a masked summary and the ticket link", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const sent = await notifyUrgentEscalation(store(), send, {
      ...base,
      reasons: ["customer_requested_human"],
    });
    expect(sent).toBe(true);
    const [to, subject, body] = send.mock.calls[0];
    expect(to).toBe("team@client.example");
    expect(subject).toBe("[Harbor & Pine] Needs a person: customer asked for a person");
    expect(body).toContain(base.ticketUrl);
    expect(body).not.toContain("olivia.bennett@example.com"); // PII-masked
  });

  it("stays quiet for non-urgent reasons (they go in the daily digest)", async () => {
    const send = vi.fn();
    expect(
      await notifyUrgentEscalation(store(), send, { ...base, reasons: ["low_confidence"] }),
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("does nothing without a team address, and respects the hourly cap", async () => {
    const send = vi.fn();
    expect(
      await notifyUrgentEscalation(store(), send, {
        ...base,
        to: null,
        reasons: ["legal_or_safety"],
      }),
    ).toBe(false);
    const capped = store(false);
    expect(
      await notifyUrgentEscalation(capped, send, { ...base, reasons: ["legal_or_safety"] }),
    ).toBe(false);
    expect(capped.rateLimit).toHaveBeenCalledWith("escalation-notify:t1", 3600, URGENT_PER_HOUR);
    expect(send).not.toHaveBeenCalled();
  });

  it("never throws when sending fails (the ticket is unaffected)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("gmail down"));
    await expect(
      notifyUrgentEscalation(store(), send, { ...base, reasons: ["suspected_prompt_injection"] }),
    ).resolves.toBe(false);
  });
});

describe("daily digest", () => {
  const now = new Date("2026-11-06T13:00:00Z");
  const url = (id: string) => `https://app.example/dashboard/tickets/${id}`;

  it("is skipped when nothing is waiting", () => {
    expect(buildDigest("Harbor & Pine", [], url, now)).toBeNull();
  });

  it("lists waiting escalations with reasons, age, masked summary and links", () => {
    const d = buildDigest(
      "Harbor & Pine",
      [
        {
          ticketId: "a",
          reasons: ["low_confidence"],
          summary: "Gift wrap question from x@y.com",
          createdAt: "2026-11-05T13:00:00Z",
        },
        {
          ticketId: "b",
          reasons: ["draft_review"],
          summary: "Refund draft",
          createdAt: "2026-11-06T10:00:00Z",
        },
      ],
      url,
      now,
    )!;
    expect(d.subject).toBe("[Harbor & Pine] 2 escalations waiting (oldest 24 h)");
    expect(d.body).toContain("agent not confident · waiting 24 h");
    expect(d.body).toContain("draft waiting for approval · waiting 3 h");
    expect(d.body).toContain(url("a"));
    expect(d.body).not.toContain("x@y.com");
  });

  it("caps the list at 15 and points to the dashboard for the rest", () => {
    const many = Array.from({ length: 18 }, (_, i) => ({
      ticketId: `t${i}`,
      reasons: ["agent_error"],
      summary: "s",
      createdAt: "2026-11-06T12:00:00Z",
    }));
    expect(buildDigest("X", many, url, now)!.body).toContain("…and 3 more in the dashboard.");
  });

  it("labels unknown reason codes readably", () => {
    expect(reasonLabel("some_new_reason")).toBe("some new reason");
  });
});
