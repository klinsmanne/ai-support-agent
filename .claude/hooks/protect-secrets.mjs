#!/usr/bin/env node
// PreToolUse hook: blocks Claude from editing or writing secret files.
// Exit code 2 tells Claude Code to block the tool call and show stderr to the model.
import { basename } from "node:path";

const input = JSON.parse(await new Response(process.stdin).text());
const filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path ?? "";
const name = basename(filePath);

const isSecretFile =
  (/^\.env(\..+)?$/.test(name) && name !== ".env.example") ||
  /\.(pem|key|p12|pfx)$/.test(name) ||
  /^(credentials|client_secret|service-account).*\.json$/i.test(name);

if (isSecretFile) {
  console.error(
    `Blocked: ${name} may contain secrets. Manage secrets via env tooling (vercel env, supabase secrets), not file edits.`,
  );
  process.exit(2);
}
