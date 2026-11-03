#!/usr/bin/env node
// PreToolUse hook: stops Claude from reading, editing or shell-accessing secret files.
// Exit code 2 blocks the tool call and shows stderr to the model. Fails closed on bad input.
import { basename } from "node:path";

const block = (reason) => {
  console.error(
    `Blocked: ${reason}. Manage secrets via env tooling (vercel env, supabase secrets), not file access.`,
  );
  process.exit(2);
};

let input;
try {
  input = JSON.parse(await new Response(process.stdin).text());
} catch {
  block("hook received unreadable input");
}

const isSecretName = (name) =>
  // Prefix match also catches globs like `.env*` and variants like `.env.staging.local`.
  (name.startsWith(".env") && name !== ".env.example") ||
  /\.(pem|key|p12|pfx)$/.test(name) ||
  /^(credentials|client_secret|service-account).*\.json$/i.test(name);

const toolInput = input?.tool_input ?? {};

if (input?.tool_name === "Bash") {
  // Any shell reference to a secret file (cat, grep, cp, redirects, node -e ...) is blocked.
  const command = String(toolInput.command ?? "");
  const tokens = command.split(/[\s"'`;|&<>()=]+/).map((t) => basename(t));
  const hit = tokens.find((t) => t && isSecretName(t));
  if (hit) block(`shell command references secret file ${hit}`);
  process.exit(0);
}

const filePath = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path ?? "";
const name = basename(String(filePath));
if (name && isSecretName(name)) block(`${name} may contain secrets`);
