import { NextResponse } from "next/server";
import { createUserClient } from "@/lib/auth/server";

/** Magic-link landing: exchanges the one-time code (PKCE) for a session cookie. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) {
    const db = await createUserClient();
    const { error } = await db.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/dashboard", url.origin));
  }
  return NextResponse.redirect(new URL("/login?error=link", url.origin));
}
