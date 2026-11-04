"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createUserClient } from "@/lib/auth/server";

/**
 * Sends a sign-in link. Sign-up is disabled at the Supabase level and shouldCreateUser=false here,
 * so only invited owners/agents can sign in. The response never reveals whether an email is invited.
 */
export async function sendMagicLink(_prev: unknown, form: FormData): Promise<{ message: string }> {
  const email = z.email().safeParse(
    String(form.get("email") ?? "")
      .trim()
      .toLowerCase(),
  );
  if (!email.success) return { message: "Please enter a valid email address." };
  const origin = (await headers()).get("origin") ?? process.env.APP_URL ?? "http://localhost:3000";
  const db = await createUserClient();
  await db.auth.signInWithOtp({
    email: email.data,
    options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/callback` },
  });
  return { message: "If that email is invited, a sign-in link is on its way. Check your inbox." };
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
