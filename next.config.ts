import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";
const TURNSTILE = "https://challenges.cloudflare.com";

/**
 * Content Security Policy. Scripts and frames may only come from this site and Cloudflare
 * Turnstile, and the browser may only talk to this site, so injected markup can't load a remote
 * script or send data elsewhere. 'unsafe-inline' scripts remain because a per-request nonce would
 * make every page dynamic (no static landing page); see docs/DECISIONS.md ADR-020.
 * frame-ancestors/X-Frame-Options stop the dashboard being framed for clickjacking.
 */
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${TURNSTILE}${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  `frame-src ${TURNSTILE}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
