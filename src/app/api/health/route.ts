import { getContainer } from "@/lib/server/container";

/** Liveness + keep-alive: touches the database so the free Supabase project never pauses. */
export async function GET() {
  try {
    const c = getContainer();
    await c.defaultTenantId();
    return Response.json({ ok: true, time: new Date().toISOString() });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
