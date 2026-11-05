import { Suspense } from "react";
import { SettingsForm } from "@/components/dashboard/SettingsForm";
import { TenantTabs } from "@/components/dashboard/TenantTabs";
import { dashboardContext } from "@/lib/dashboard/context";
import { getSettings } from "@/lib/dashboard/data";
import { getContainer } from "@/lib/server/container";

type Params = Promise<{ t?: string }>;

export default function SettingsPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading settings…</p>}>
      <SettingsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function SettingsContent({ searchParams }: { searchParams: Params }) {
  const { t } = await searchParams;
  const ctx = await dashboardContext(t);
  const settings = await getSettings(ctx.db, ctx.tenant.tenantId);
  if (!settings) return <p className="text-sm text-zinc-500">No settings found.</p>;
  // The team address is server-only in the database (migration 14): read it with the service
  // client, and send the address itself only to owners. Viewers learn only whether it's set.
  const { data: notify } = await getContainer()
    .db.from("tenant_settings")
    .select("escalation_notify_email")
    .eq("tenant_id", ctx.tenant.tenantId)
    .maybeSingle();
  const notifyEmail: string | null = notify?.escalation_notify_email ?? null;
  return (
    <div>
      <TenantTabs
        memberships={ctx.viewer.memberships}
        current={ctx.tenant.slug}
        path="/dashboard/settings"
      />
      <h1 className="mb-1 text-lg font-semibold">{ctx.tenant.name} settings</h1>
      <p className="mb-4 text-sm text-zinc-500">
        Brand voice: “{settings.brand_voice}” · Languages: {settings.supported_languages.join(", ")}{" "}
        · Tools: {settings.enabled_tools.join(", ")}
      </p>
      <SettingsForm
        tenantId={ctx.tenant.tenantId}
        // The team's notification address goes only to owners' browsers, never to viewers
        // (the public demo account can open this page).
        settings={{
          ...settings,
          escalation_notify_email: ctx.isOwner ? notifyEmail : null,
          escalation_notify_configured: !!notifyEmail,
        }}
        isOwner={ctx.isOwner}
      />
    </div>
  );
}
