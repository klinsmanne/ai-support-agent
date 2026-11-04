/**
 * Provisions dashboard access (idempotent):
 *  - the public read-only demo viewer (no usable password; signs in via a one-time server token), viewer role on
 *    every tenant;
 *  - an owner (invited by email; signs in with a magic link), owner role on every tenant.
 * Usage: npm run dashboard:users -- [owner-email]
 */
import "./load-env.ts";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServiceClient } from "../src/lib/db/client.ts";

const env = process.env as Record<string, string>;
const db = createServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
const ownerEmail = process.argv[2]?.toLowerCase();

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

const { data: tenants } = await db.from("tenants").select("id, slug");
if (!tenants?.length) throw new Error("no tenants");

async function grant(userId: string, role: "owner" | "viewer") {
  const rows = tenants!.map((t) => ({ tenant_id: t.id, user_id: userId, role }));
  const { error } = await db
    .from("tenant_members")
    .upsert(rows, { onConflict: "tenant_id,user_id" });
  if (error) throw new Error(error.message);
}

// Demo viewer: random password that nobody keeps (sign-in is a server-minted one-time token).
const demoEmail = env.DEMO_VIEWER_EMAIL || "demo-viewer@support-agent.example";
const demoId = await ensureUser(demoEmail, randomBytes(32).toString("base64url"));
await grant(demoId, "viewer");
setSecret("DEMO_VIEWER_EMAIL", demoEmail);
console.log(`✓ demo viewer ready (viewer on ${tenants.length} tenants); no stored password`);

if (ownerEmail) {
  const ownerId = await ensureUser(ownerEmail);
  await grant(ownerId, "owner");
  console.log(
    `✓ owner invited: ${ownerEmail.replace(/^(.).*@/, "$1***@")} (owner on ${tenants.length} tenants) — sign in with a magic link`,
  );
}
