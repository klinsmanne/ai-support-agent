import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { connection } from "next/server";

/**
 * Supabase client acting AS the signed-in dashboard user (publishable key + their session cookie).
 * Every query through it is subject to Row Level Security, so a member can only ever read their
 * own tenants' rows — the database enforces it, not this code. Create one per request.
 */
export async function createUserClient(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        // Server Components can't set cookies; the proxy refreshes sessions, so ignoring is safe here.
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          /* called from a Server Component */
        }
      },
    },
  });
}

export type Role = "owner" | "agent" | "viewer";

export interface Membership {
  tenantId: string;
  slug: string;
  name: string;
  role: Role;
}

export interface Viewer {
  userId: string;
  email: string | null;
  memberships: Membership[];
  isDemo: boolean;
}

/**
 * The current dashboard user and their tenant memberships, or null when signed out.
 * Uses getUser() (verifies the JWT with Supabase), never getSession() (unverified cookie data).
 */
export async function getViewer(): Promise<Viewer | null> {
  // Session checks compare token expiry with the current time: mark this as request-time work so
  // Cache Components never tries to prerender it.
  await connection();
  const db = await createUserClient();
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) return null;
  const { data: rows } = await db
    .from("tenant_members")
    .select("tenant_id, role, tenants(slug, name)")
    .eq("user_id", data.user.id);
  const memberships = (rows ?? []).flatMap((r) => {
    const t = Array.isArray(r.tenants) ? r.tenants[0] : r.tenants;
    return t
      ? [
          {
            tenantId: r.tenant_id as string,
            slug: t.slug as string,
            name: t.name as string,
            role: r.role as Role,
          },
        ]
      : [];
  });
  // Main demo company first, then alphabetical.
  memberships.sort((a, b) =>
    a.slug === "harbor-pine" ? -1 : b.slug === "harbor-pine" ? 1 : a.name.localeCompare(b.name),
  );
  return {
    userId: data.user.id,
    email: data.user.email ?? null,
    memberships,
    isDemo: data.user.email === process.env.DEMO_VIEWER_EMAIL,
  };
}

/** Throws unless the viewer has one of `roles` on `tenantId` — used by every write action. */
export function requireRole(viewer: Viewer | null, tenantId: string, roles: Role[]): Membership {
  const m = viewer?.memberships.find((x) => x.tenantId === tenantId);
  if (!m || !roles.includes(m.role)) throw new Error("forbidden");
  return m;
}
