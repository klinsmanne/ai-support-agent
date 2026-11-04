import "server-only";
import { redirect } from "next/navigation";
import { createUserClient, getViewer, type Membership, type Viewer } from "@/lib/auth/server";

export interface DashboardContext {
  viewer: Viewer;
  tenant: Membership;
  db: Awaited<ReturnType<typeof createUserClient>>;
  canEdit: boolean;
  isOwner: boolean;
}

/**
 * Resolves the signed-in user and the selected tenant (?t=<slug>, default: first membership).
 * Anyone without a membership for the requested tenant gets their own first tenant instead —
 * never another tenant's data (RLS would return nothing anyway).
 */
export async function dashboardContext(slug?: string): Promise<DashboardContext> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (!viewer.memberships.length) redirect("/login?error=no-access");
  const tenant = viewer.memberships.find((m) => m.slug === slug) ?? viewer.memberships[0];
  return {
    viewer,
    tenant,
    db: await createUserClient(),
    canEdit: tenant.role === "owner" || tenant.role === "agent",
    isOwner: tenant.role === "owner",
  };
}

export const fmtPct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${Math.round(v * 1000) / 10}%`;
export const fmtSeconds = (s: number | null | undefined) => {
  if (s === null || s === undefined) return "—";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
};
export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
