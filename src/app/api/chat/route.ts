import { ChatRequestSchema, handleChat } from "@/lib/channels/chat/handler";
import { getContainer } from "@/lib/server/container";

export const maxDuration = 60;

/**
 * Same-origin check: the widget lives on our own site, so cross-site POSTs are refused (CSRF).
 * Compares against the Host header (set by Vercel's edge, not the client) and APP_URL; the
 * client-controllable x-forwarded-host is deliberately ignored.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = new Set([
    request.headers.get("host"),
    process.env.APP_URL ? new URL(process.env.APP_URL).host : null,
  ]);
  return allowed.has(originHost);
}

async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // bot protection disabled until Turnstile keys are configured
  if (!token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    signal: AbortSignal.timeout(5_000),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean };
  return json.success === true;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return Response.json({ error: "expected JSON" }, { status: 415 });
  }
  const parsed = ChatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });

  const c = getContainer();
  const secret = c.env.CSRF_SECRET;
  if (!secret) return Response.json({ error: "chat not configured" }, { status: 503 });
  // x-real-ip is set by Vercel's edge; x-forwarded-for can be prefixed by the client, so it's not used.
  const ip = request.headers.get("x-real-ip") ?? "unknown";

  const result = await handleChat(parsed.data, ip, {
    pipeline: c.deps,
    chat: c.chat,
    secret,
    verifyTurnstile,
  });
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
