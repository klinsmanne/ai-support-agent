import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Runs before /dashboard requests: refreshes the Supabase session cookie and redirects signed-out
 * visitors to /login. This is an optimistic check only — every page and action re-verifies the
 * user server-side (getViewer/requireRole) and RLS enforces access in the database.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        // Responses that set auth cookies must never be cached (one user's session served to another).
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
      },
    },
  });
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    return NextResponse.redirect(login);
  }
  return response;
}

export const config = { matcher: ["/dashboard/:path*"] };
