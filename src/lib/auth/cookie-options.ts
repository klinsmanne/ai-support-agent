/** Session cookies: not readable by page scripts, HTTPS-only in production, not sent cross-site. */
export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
} as const;
