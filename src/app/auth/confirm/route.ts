import { NextResponse } from "next/server";
import { createUserClient } from "@/lib/auth/server";

/**
 * Magic-link landing (token-hash flow): verifies the one-time token server-side and sets the
 * session cookie. Works in whatever browser the email is opened in.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  if (
    tokenHash &&
    /^[A-Za-z0-9_-]{10,200}$/.test(tokenHash) &&
    (type === "email" || type === "magiclink")
  ) {
    const db = await createUserClient();
    const { error } = await db.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) return NextResponse.redirect(new URL("/dashboard", url.origin));
  }
  return NextResponse.redirect(new URL("/login?error=link", url.origin));
}
