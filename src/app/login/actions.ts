"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { createUserClient } from "@/lib/auth/server";
import { getContainer } from "@/lib/server/container";

const SENT = {
  message: "If that email is invited, a sign-in link is on its way. Check your inbox.",
};

/**
 * The site's own base URL for links in emails. Never derived from request headers in production:
 * a forged Host header would otherwise put a valid sign-in token on an attacker's domain.
 */
function appOrigin(): string {
  if (process.env.APP_URL) return new URL(process.env.APP_URL).origin;
  if (process.env.NODE_ENV === "production") throw new Error("APP_URL must be set in production");
  return "http://localhost:3000";
}

/**
 * Sends a sign-in link from our own support inbox (Gmail API, $0). The link carries a one-time
 * token hash verified at /auth/confirm, so it works in any browser. Only existing users with a
 * team membership (owner/agent) get a link — generateLink() would otherwise create accounts.
 * Every request gets the same instant answer; the lookup and send run after the response, so
 * neither the text nor the timing reveals which emails are invited.
 */
export async function sendMagicLink(_prev: unknown, form: FormData): Promise<{ message: string }> {
  const email = z.email().safeParse(
    String(form.get("email") ?? "")
      .trim()
      .toLowerCase(),
  );
  if (!email.success) return { message: "Please enter a valid email address." };
  const ip = (await headers()).get("x-real-ip") ?? "unknown";
  const origin = appOrigin();
  after(async () => {
    const c = getContainer();
    const allowed =
      (await c.store.rateLimit(`magic-link:${email.data}`, 3600, 5)) &&
      (await c.store.rateLimit(`magic-link-ip:${ip}`, 3600, 20));
    if (!allowed || !c.gmail) return;
    const userId = await findTeamMember(email.data);
    if (!userId) return;
    const { data, error } = await c.db.auth.admin.generateLink({
      type: "magiclink",
      email: email.data,
    });
    if (error || !data.properties?.hashed_token) return;
    const link = `${origin}/auth/confirm?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=magiclink`;
    await c.gmail
      .sendNew(
        email.data,
        "Your Support Ops sign-in link",
        `Hi,\n\nUse this link to sign in to the Support Ops dashboard (it works once and expires in 1 hour):\n\n${link}\n\nIf you didn't request it, you can ignore this email.\n\n— Support Ops`,
      )
      .then(() => c.store.addUsage("gmail", "emails_sent", 1))
      .catch(() => {});
  });
  return SENT;
}

async function findTeamMember(email: string): Promise<string | null> {
  const db = getContainer().db;
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return null;
    const user = data.users.find((u) => u.email?.toLowerCase() === email);
    if (user) {
      const { count } = await db
        .from("tenant_members")
        .select("user_id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .in("role", ["owner", "agent"]);
      return count ? user.id : null;
    }
    if (data.users.length < 200) return null;
  }
  return null;
}

/**
 * One-click read-only demo. Sign-in never uses a password: the server mints a one-time token for
 * the demo account and verifies it immediately, so a visitor who changes the account's password
 * can't lock other visitors out (and email changes need confirmation at the unreachable old
 * address). Don't touch the user between generateLink and verifyOtp — any update voids the token.
 */
export async function viewDemo(): Promise<void> {
  const email = process.env.DEMO_VIEWER_EMAIL;
  if (!email) redirect("/login?error=demo");
  const c = getContainer();
  const ip = (await headers()).get("x-real-ip") ?? "unknown";
  if (!(await c.store.rateLimit(`demo-login:${ip}`, 3600, 30))) redirect("/login?error=demo");
  const { data, error } = await c.db.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) redirect("/login?error=demo");
  const db = await createUserClient();
  const { error: verifyError } = await db.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: "magiclink",
  });
  redirect(verifyError ? "/login?error=demo" : "/dashboard");
}

export async function signOut(): Promise<void> {
  const db = await createUserClient();
  await db.auth.signOut({ scope: "local" });
  redirect("/login");
}
