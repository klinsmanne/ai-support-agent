import { maskPII } from "../guardrails/pii.ts";
import type { PipelineStore } from "./store.ts";

/** Failures of one kind within a clock hour before the operator is emailed. One is noise. */
export const ALERT_THRESHOLD = 3;

export type AlertSend = (subject: string, body: string) => Promise<void>;

/**
 * Counts a failure and alerts the operator when the same kind repeats (≥ 3 in the same clock
 * hour — fixed windows, so failures straddling the hour can be missed), at most once per kind
 * per hour so an outage doesn't flood the inbox. Alerts go to email and to ntfy push
 * (alert-channels.ts), so a Gmail outage still reaches the operator. Uses the same atomic
 * counters as rate limiting, so concurrent serverless instances agree. Never throws: alerting must not turn
 * a handled failure into an unhandled one. Details are PII-masked before they leave the system.
 */
export async function reportFailure(
  store: Pick<PipelineStore, "rateLimit">,
  send: AlertSend | null | undefined,
  kind: string,
  detail: string,
): Promise<boolean> {
  if (!send) return false;
  try {
    const belowThreshold = await store.rateLimit(`failures:${kind}`, 3600, ALERT_THRESHOLD - 1);
    if (belowThreshold) return false;
    if (!(await store.rateLimit(`alert-sent:${kind}`, 3600, 1))) return false;
    await send(
      `[Support Ops] Repeated failures: ${kind}`,
      [
        `"${kind}" failed ${ALERT_THRESHOLD}+ times in the last hour.`,
        "",
        `Latest error: ${maskPII(detail).slice(0, 500)}`,
        "",
        'Affected tickets are marked "needs attention" in the dashboard; nothing was dropped.',
        "You won't get another alert for this kind of failure for an hour.",
      ].join("\n"),
    );
    return true;
  } catch {
    return false;
  }
}
