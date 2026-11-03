#!/usr/bin/env node
// PostToolUse hook: auto-formats (Prettier) and lint-fixes (ESLint) each file Claude edits.
// Remaining lint errors are reported back to Claude (exit 2) so they get fixed right away.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const input = JSON.parse(await new Response(process.stdin).text());
const filePath = input?.tool_input?.file_path;
if (!filePath || !existsSync(filePath) || filePath.includes("node_modules")) process.exit(0);

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: process.env.CLAUDE_PROJECT_DIR, stdio: "pipe", encoding: "utf8" });

if (/\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|ya?ml)$/.test(filePath)) {
  try {
    run("npx", ["prettier", "--write", "--ignore-unknown", filePath]);
  } catch {
    // Formatting failures (e.g. ignored files) should never block work.
  }
}

if (/\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) {
  try {
    run("npx", ["eslint", "--fix", filePath]);
  } catch (error) {
    console.error(`ESLint found problems in ${filePath}:\n${error.stdout ?? error.message}`);
    process.exit(2);
  }
}
