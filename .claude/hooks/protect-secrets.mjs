#!/usr/bin/env node
// PreToolUse hook: stops Claude from reading, editing or shell-accessing secret files.
// Exit code 2 blocks the tool call and shows stderr to the model. Fails closed on bad input.
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

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

// Prefix match also catches globs like `.env*` and variants like `.env.staging.local`.
const isEnvFile = (name) => name.startsWith(".env") && name !== ".env.example";
const isKeyFile = (name) =>
  /\.(pem|key|p12|pfx)$/.test(name) ||
  /^(credentials|client_secret|service-account).*\.json$/i.test(name);
const isSecretName = (name) => isEnvFile(name) || isKeyFile(name);

const toolInput = input?.tool_input ?? {};

if (input?.tool_name === "Bash") {
  // Any shell reference to a secret file (cat, grep, cp, redirects, node -e ...) is blocked.
  // `.env*` names are always blocked. Key/cert names only count when such a file exists,
  // so code like `c.key` or `obj.pem` inside a command isn't a false positive.
  const command = String(toolInput.command ?? "");
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const raw = command.split(/[\s"'`;|&<>()=,]+/).filter(Boolean);
  const hit = raw.find((token) => {
    const name = basename(token);
    if (isEnvFile(name)) return true;
    return isKeyFile(name) && (token.includes("*") || existsSync(resolve(cwd, token)));
  });
  if (hit) block(`shell command references secret file ${basename(hit)}`);
  process.exit(0);
}

const filePath = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path ?? "";
const name = basename(String(filePath));
if (name && isSecretName(name)) block(`${name} may contain secrets`);
