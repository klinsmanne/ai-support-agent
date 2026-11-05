import { maskPII } from "../guardrails/pii.ts";
import type { PipelineStore } from "./store.ts";

/**
 * Escalation notifications (ADR-027). Escalations land in the dashboard queue; this tells the
 * client's team they exist: urgent ones right away, the rest in a daily digest. Messages carry
 * the reason, a PII-masked summary and a dashboard link, never the customer's message text.
 */

/** Reasons a person should see within minutes, not at tomorrow's digest. */
export const URGENT_REASONS = new Set([
  "customer_requested_human",
  "very_negative_sentiment",
  "legal_or_safety",
  "amount_above_threshold",
  "suspected_prompt_injection",
]);

const LABELS: Record<string, string> = {
  customer_requested_human: "customer asked for a person",
  very_negative_sentiment: "very upset customer",
  legal_or_safety: "legal or safety issue",
  amount_above_threshold: "refund above the auto-approve limit",
  suspected_prompt_injection: "suspected manipulation attempt",
  low_confidence: "agent not confident",
  outside_policy: "outside policy",
  draft_review: "draft waiting for approval",
  unauthenticated_sender: "sender not verified",
  reply_validation_failed: "reply failed a safety check",
  agent_error: "agent couldn't finish",
  reply_cap_reached: "reply limit reached for this conversation",
  kill_switch_active: "AI paused (kill switch)",
};
export const reasonLabel = (code: string) => LABELS[code] ?? code.replace(/_/g, " ");

/**
 * The summary is written by the model and can echo what a customer wrote, so before it goes into
 * a team email: links are removed (an attacker could plant a phishing URL), PII is masked, and a
 * suspected manipulation attempt gets a fixed summary instead of anything derived from it.
 */
export function safeSummary(summary: string, reasons: string[], max = 400): string {
  if (reasons.includes("suspected_prompt_injection"))
    return "Message flagged as a possible manipulation attempt. Open the ticket to review it.";
  return maskPII(summary)
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link removed]")
    .replace(
      /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|xyz|info|biz|ru|cn|ly|me)\b\S*/gi,
      "[link removed]",
    )
    .slice(0, max);
}

/** At most this many instant emails per client per hour, so an attack can't flood the team. */
export const URGENT_PER_HOUR = 20;

export type TeamSend = (to: string, subject: string, body: string) => Promise<unknown>;

export async function notifyUrgentEscalation(
  store: Pick<PipelineStore, "rateLimit">,
  send: TeamSend | null | undefined,
  opts: {
    tenantId: string;
    brand: string;
    to: string | null | undefined;
    ticketId: string;
    reasons: string[];
    summary: string;
    ticketUrl?: string;
  },
): Promise<boolean> {
  const urgent = opts.reasons.filter((r) => URGENT_REASONS.has(r));
  if (!send || !opts.to || !urgent.length) return false;
  try {
    if (!(await store.rateLimit(`escalation-notify:${opts.tenantId}`, 3600, URGENT_PER_HOUR)))
      return false;
    const what = urgent.map(reasonLabel).join(", ");
    await send(
      opts.to,
      `[${opts.brand}] Needs a person: ${what}`,
      [
        `A ticket was escalated to your team (${what}).`,
        "",
        `Summary: ${safeSummary(opts.summary, urgent)}`,
        "",
        opts.ticketUrl
          ? `Review it and approve, edit or reject the drafted reply: ${opts.ticketUrl}`
          : "Review it in the dashboard's Escalations queue.",
        "",
        "You get these for urgent escalations only; everything else is in the daily digest.",
      ].join("\n"),
    );
    return true;
  } catch {
    return false; // notification failures never affect the ticket
  }
}

export interface PendingEscalation {
  ticketId: string;
  reasons: string[];
  summary: string;
  createdAt: string;
}

/** The daily digest email for one client, or null when nothing is waiting. */
export function buildDigest(
  brand: string,
  pending: PendingEscalation[],
  ticketUrl: (id: string) => string,
  now = new Date(),
): { subject: string; body: string } | null {
  if (!pending.length) return null;
  const oldest = Math.max(
    ...pending.map((p) => (now.getTime() - new Date(p.createdAt).getTime()) / 3_600_000),
  );
  const lines = pending.slice(0, 15).map((p) => {
    const hours = Math.max(
      0,
      Math.round((now.getTime() - new Date(p.createdAt).getTime()) / 3_600_000),
    );
    return `• ${p.reasons.map(reasonLabel).join(", ")} · waiting ${hours} h\n  ${safeSummary(p.summary, p.reasons, 160)}\n  ${ticketUrl(p.ticketId)}`;
  });
  return {
    subject: `[${brand}] ${pending.length} escalation${pending.length === 1 ? "" : "s"} waiting (oldest ${Math.round(oldest)} h)`,
    body: [
      `${pending.length} ticket${pending.length === 1 ? " is" : "s are"} waiting for your team:`,
      "",
      ...lines,
      ...(pending.length > 15 ? ["", `…and ${pending.length - 15} more in the dashboard.`] : []),
      "",
      "Turn this digest off or change the address in the dashboard: Settings → Notifications.",
    ].join("\n"),
  };
}
