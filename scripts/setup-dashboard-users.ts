/**
 * Provisions dashboard access (idempotent):
 *  - the public read-only demo viewer (no usable password; signs in via a one-time server token),
 *    viewer role on **demo tenants only**: a real client's tenant is never visible to the public demo;
 *  - an invited person (signs in with a magic link). Without --tenant: owner on every tenant (the
 *    operator running the deployment). With --tenant: that one client only, with --role.
 *
 * Usage:
 *   npm run dashboard:users                                   # demo viewer only
 *   npm run dashboard:users -- you@example.com                # operator: owner on all tenants
 *   npm run dashboard:users -- lead@client.com --tenant client-slug --role agent   # client team
 */
import "./load-env.ts";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServiceClient } from "../src/lib/db/client.ts";

const env = process.env as Record<string, string>;
const db = createServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ownerEmail = args.find((a) => !a.startsWith("--") && a.includes("@"))?.toLowerCase();
const onlyTenant = flag("tenant");
const role = (flag("role") ?? "owner") as "owner" | "agent" | "viewer";
if (!["owner", "agent", "viewer"].includes(role))
  throw new Error("--role must be owner, agent or viewer");
if (flag("role") && !onlyTenant)
  throw new Error("--role needs --tenant (operators are owners everywhere)");

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

const { data: tenants } = await db.from("tenants").select("id, slug, is_demo");
if (!tenants?.length) throw new Error("no tenants");

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
  const { error } = await db
    .from("tenant_members")
    .delete()
    .eq("user_id", demoId)
    .in("tenant_id", nonDemo);
  if (error) throw new Error(error.message);
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
