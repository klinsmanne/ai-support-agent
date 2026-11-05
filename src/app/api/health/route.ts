import { getContainer } from "@/lib/server/container";

/**
 * Liveness + keep-alive: touches the database so the free Supabase project never pauses. Reports
 * the deployed commit (public repo, so not sensitive) so the post-deploy smoke tests can wait
 * until the new build is live before testing it.
 */
export async function GET() {
  try {
    const c = getContainer();
    await c.defaultTenantId();
    return Response.json({
      ok: true,
      time: new Date().toISOString(),
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
