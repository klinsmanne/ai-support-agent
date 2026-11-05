import type { AlertSend } from "./alerts.ts";

/**
 * Push alerts through ntfy (https://ntfy.sh): free, open source, no account. The operator
 * subscribes to the topic in the ntfy phone app. Anyone who knows a public topic name can read
 * it, so the topic is a long random secret (validated in env.ts), and alert bodies are already
 * PII-masked by reportFailure. This is the second channel next to email, so a Gmail outage (the
 * failure most likely to need an alert) still reaches the operator (ADR-026).
 */
export function ntfySender(topic: string, fetchFn: typeof fetch = fetch): AlertSend {
  return async (subject, body) => {
    const res = await fetchFn(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      // HTTP headers must be ASCII; subjects are built from fixed text plus a failure kind.
      headers: { Title: subject.replace(/[^\x20-\x7E]/g, "?"), Priority: "high", Tags: "warning" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
  };
}

/**
 * Sends to every channel in parallel. Succeeds if at least one channel delivered; throws only
 * when all fail (reportFailure swallows it, so alerting never breaks the pipeline).
 */
export function fanOut(channels: AlertSend[]): AlertSend {
  return async (subject, body) => {
    const results = await Promise.allSettled(channels.map((send) => send(subject, body)));
    // Log which channel failed (by position only: an error could carry the secret ntfy topic),
    // so a silently broken channel is visible in the logs even when another one delivered.
    results.forEach((r, i) => {
      if (r.status === "rejected")
        console.warn(`alert channel ${i + 1} of ${channels.length} failed`);
    });
    if (!results.some((r) => r.status === "fulfilled"))
      throw new Error("every alert channel failed");
  };
}
