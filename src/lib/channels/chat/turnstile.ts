/**
 * Server-side Cloudflare Turnstile check for starting a chat session. Fails closed in
 * production: a missing secret, a Cloudflare outage, or a token solved on another site all
 * refuse the session. In development without keys it allows the request (local testing).
 */
export async function verifyTurnstile(
  token: string | undefined,
  ip: string,
  env: { TURNSTILE_SECRET_KEY?: string; NODE_ENV?: string; APP_URL?: string },
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  // Fail closed in production: a missing key must not silently switch bot protection off.
  if (!secret) return env.NODE_ENV !== "production";
  if (!token) return false;
  try {
    const res = await fetchFn("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5_000),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; hostname?: string };
    if (json.success !== true) return false;
    // A token solved on another site can't be replayed here (checked when APP_URL is known).
    const appHost = env.APP_URL ? new URL(env.APP_URL).hostname : null;
    return !appHost || json.hostname === appHost;
  } catch {
    return false; // Cloudflare unreachable: refuse new sessions rather than open the gate
  }
}
