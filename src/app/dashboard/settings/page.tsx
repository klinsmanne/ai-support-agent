import { Suspense } from "react";
import { SettingsForm } from "@/components/dashboard/SettingsForm";
import { TenantTabs } from "@/components/dashboard/TenantTabs";
import { dashboardContext } from "@/lib/dashboard/context";
import { getSettings } from "@/lib/dashboard/data";

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
      <SettingsForm tenantId={ctx.tenant.tenantId} settings={settings} isOwner={ctx.isOwner} />
    </div>
  );
}
