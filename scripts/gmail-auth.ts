/**
 * One-time Gmail authorization for the support inbox (OAuth 2.0 loopback flow with PKCE).
 * Opens Google's consent page in Chrome, receives the code on 127.0.0.1, stores the refresh
 * token in the macOS Keychain (never printed), and verifies it by reading the inbox profile.
 * Usage: npm run gmail:auth
 */
import "./load-env.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const SCOPE = "https://www.googleapis.com/auth/gmail.modify"; // read, label, send — no permanent delete
const {
  GMAIL_CLIENT_ID: clientId,
  GMAIL_CLIENT_SECRET: clientSecret,
  SUPPORT_EMAIL_ADDRESS: expected,
} = process.env;
if (!clientId || !clientSecret || !expected) {
  console.error(
    "Missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / SUPPORT_EMAIL_ADDRESS (npm run secrets sync)",
  );
  process.exit(1);
}

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/") return void res.writeHead(404).end();
    const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        ok
          ? "<h2>✅ Gmail connected. You can close this tab and go back to Claude.</h2>"
          : `<h2>❌ Authorization failed: ${url.searchParams.get("error") ?? "state mismatch"}</h2>`,
      );
    // Read the port before closing: address() returns null once the server is closed.
    const { port } = server.address() as AddressInfo;
    server.close();
    if (ok) resolve({ code: ok, redirectUri: `http://127.0.0.1:${port}` });
    else reject(new Error(url.searchParams.get("error") ?? "state mismatch"));
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `http://127.0.0.1:${port}`,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent", // always return a refresh token
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      login_hint: expected,
    }).toString();
    console.log("Opening Google consent page in Chrome… sign in as", expected);
    execFileSync("open", ["-a", "Google Chrome", auth.toString()]);
  });
  setTimeout(() => reject(new Error("timed out after 10 minutes")), 600_000).unref();
});

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code: code.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: code.redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  }),
});
const tokens = (await tokenRes.json()) as {
  refresh_token?: string;
  access_token?: string;
  error?: string;
};
if (!tokenRes.ok || !tokens.refresh_token || !tokens.access_token) {
  console.error("Token exchange failed:", tokens.error ?? tokenRes.status);
  process.exit(1);
}

const profile = (await (
  await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })
).json()) as { emailAddress?: string; messagesTotal?: number };
if (profile.emailAddress?.toLowerCase() !== expected.toLowerCase()) {
  console.error(
    `Signed in as ${profile.emailAddress}, expected ${expected}. Token NOT saved — run again and pick the support inbox.`,
  );
  process.exit(1);
}

const stored = spawnSync("node", ["scripts/secrets.mjs", "set", "GMAIL_REFRESH_TOKEN"], {
  input: tokens.refresh_token,
  encoding: "utf8",
});
process.stdout.write(stored.stdout || stored.stderr);
console.log(
  `✓ Gmail connected for ${profile.emailAddress} (${profile.messagesTotal ?? 0} messages in mailbox)`,
);
