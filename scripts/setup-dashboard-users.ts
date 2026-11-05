/**
 * Provisions dashboard access (idempotent):
 *  - the public read-only demo viewer (no usable password; signs in via a one-time server token),
 *    viewer role on **demo tenants only**: a real client's tenant is never visible to the public demo;
 *  - an invited person (signs in with a magic link): --all-tenants makes the operator owner on
 *    every tenant; --tenant scopes a client's team to that client only, with --role owner|agent.
 *
 * Usage:
 *   npm run dashboard:users                                              # demo viewer only
 *   npm run dashboard:users -- you@example.com --all-tenants             # operator: owner everywhere
 *   npm run dashboard:users -- lead@client.com --tenant client-slug --role owner   # client team
 * Unknown or malformed arguments are rejected (fail closed).
 */
import "./load-env.ts";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServiceClient } from "../src/lib/db/client.ts";
import { parseInviteArgs } from "./dashboard-users-args.ts";

const env = process.env as Record<string, string>;
const db = createServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
const { email: ownerEmail, tenant: onlyTenant, role } = parseInviteArgs(process.argv.slice(2));

const setSecret = (name: string, value: string) => {
  const r = spawnSync("node", ["scripts/secrets.mjs", "set", name], {
    input: value,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
};

async function findUser(email: string) {
  for (let page = 1; page < 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit || data.users.length < 200) return hit ?? null;
  }
  return null;
}

async function ensureUser(email: string, password?: string) {
  const existing = await findUser(email);
  if (existing) {
    if (password) await db.auth.admin.updateUserById(existing.id, { password });
    return existing.id;
  }
  const { data, error } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    ...(password ? { password } : {}),
  });
  if (error || !data.user) throw new Error(error?.message ?? "create user failed");
  return data.user.id;
}

const { data: tenantRows, error: tenantsError } = await db
  .from("tenants")
  .select("id, slug, is_demo");
if (tenantsError || !tenantRows?.length) throw new Error(tenantsError?.message ?? "no tenants");
const tenants: { id: string; slug: string; is_demo: boolean }[] = tenantRows;

async function grant(
  userId: string,
  role: "owner" | "agent" | "viewer",
  scope: { id: string; slug: string }[],
) {
  if (!scope.length) return;
  const rows = scope.map((t) => ({ tenant_id: t.id, user_id: userId, role }));
  const { error } = await db
    .from("tenant_members")
    .upsert(rows, { onConflict: "tenant_id,user_id" });
  if (error) throw new Error(error.message);
}

// Demo viewer: random password that nobody keeps (sign-in is a server-minted one-time token).
const demoEmail = env.DEMO_VIEWER_EMAIL || "demo-viewer@support-agent.example";
const demoId = await ensureUser(demoEmail, randomBytes(32).toString("base64url"));
const demoTenants = tenants.filter((t) => t.is_demo);
await grant(demoId, "viewer", demoTenants);
// Remove the demo viewer from any non-demo tenant (e.g. a tenant whose demo flag was turned off).
const nonDemo = tenants.filter((t) => !t.is_demo).map((t) => t.id);
if (nonDemo.length) {
  const { error: removeError } = await db
    .from("tenant_members")
    .delete()
    .eq("user_id", demoId)
    .in("tenant_id", nonDemo);
  if (removeError) throw new Error(removeError.message);
}
setSecret("DEMO_VIEWER_EMAIL", demoEmail);
console.log(
  `✓ demo viewer ready (viewer on ${demoTenants.length} demo tenants); no stored password`,
);

if (ownerEmail) {
  const scope = onlyTenant ? tenants.filter((t) => t.slug === onlyTenant) : tenants;
  if (!scope.length) throw new Error(`unknown tenant ${onlyTenant}`);
  const userId = await ensureUser(ownerEmail);
  await grant(userId, role, scope);
  console.log(
    `✓ invited ${ownerEmail.replace(/^(.).*@/, "$1***@")} as ${role} on ${scope.map((t) => t.slug).join(", ")} — sign in with a magic link`,
  );
}
