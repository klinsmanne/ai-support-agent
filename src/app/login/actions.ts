"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createUserClient } from "@/lib/auth/server";
import { getContainer } from "@/lib/server/container";

/**
 * Sends a sign-in link from our own support inbox (Gmail API, $0). The link carries a one-time
 * token hash verified at /auth/confirm, so it works in any browser. Only existing users with a
 * team membership (owner/agent) get a link — generateLink() would otherwise create accounts.
 * The response is identical either way, so nobody can probe which emails are invited.
 */
export async function sendMagicLink(_prev: unknown, form: FormData): Promise<{ message: string }> {
  const sent = {
    message: "If that email is invited, a sign-in link is on its way. Check your inbox.",
  };
  const email = z.email().safeParse(
    String(form.get("email") ?? "")
      .trim()
      .toLowerCase(),
  );
  if (!email.success) return { message: "Please enter a valid email address." };
  const c = getContainer();
  if (!(await c.store.rateLimit(`magic-link:${email.data}`, 3600, 5))) return sent;

  const userId = await findTeamMember(email.data);
  if (!userId || !c.gmail) return sent;
  const { data, error } = await c.db.auth.admin.generateLink({
    type: "magiclink",
    email: email.data,
  });
  if (error || !data.properties?.hashed_token) return sent;

  const h = await headers();
  const host = h.get("host");
  const origin =
    process.env.APP_URL ??
    (host
      ? `${host.startsWith("localhost") ? "http" : "https"}://${host}`
      : "http://localhost:3000");
  const link = `${origin}/auth/confirm?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=magiclink`;
  await c.gmail
    .sendNew(
      email.data,
      "Your Support Ops sign-in link",
      `Hi,\n\nUse this link to sign in to the Support Ops dashboard (it works once and expires in 1 hour):\n\n${link}\n\nIf you didn't request it, you can ignore this email.\n\n— Support Ops`,
    )
    .catch(() => {});
  return sent;
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

/** One-click read-only demo: signs in the provisioned viewer account server-side. */
export async function viewDemo(): Promise<void> {
  const email = process.env.DEMO_VIEWER_EMAIL;
  const password = process.env.DEMO_VIEWER_PASSWORD;
  if (!email || !password) redirect("/login?error=demo");
  const db = await createUserClient();
  const { error } = await db.auth.signInWithPassword({ email, password });
  redirect(error ? "/login?error=demo" : "/dashboard");
}

export async function signOut(): Promise<void> {
  const db = await createUserClient();
  await db.auth.signOut();
  redirect("/login");
}
