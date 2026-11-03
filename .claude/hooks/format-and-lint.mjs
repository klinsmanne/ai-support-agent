#!/usr/bin/env node
// PostToolUse hook: auto-formats (Prettier) and lint-fixes (ESLint) each file Claude edits.
// Remaining lint errors are reported back to Claude (exit 2) so they get fixed right away.
// Uses the project's installed binaries directly so nothing is ever downloaded on the fly.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

let input;
try {
  input = JSON.parse(await new Response(process.stdin).text());
} catch {
  process.exit(0); // Formatting is best-effort; never block work on bad hook input.
}

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const filePath = input?.tool_input?.file_path;
if (!filePath || !existsSync(filePath) || filePath.includes("node_modules")) process.exit(0);

const bin = (name) => join(projectDir, "node_modules", ".bin", name);
const run = (name, args) =>
  execFileSync(bin(name), args, { cwd: projectDir, stdio: "pipe", encoding: "utf8" });

if (/\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|ya?ml)$/.test(filePath) && existsSync(bin("prettier"))) {
  try {
    run("prettier", ["--write", "--ignore-unknown", filePath]);
  } catch {
    // Formatting failures (e.g. ignored files) should never block work.
  }
}

if (/\.(ts|tsx|js|jsx|mjs)$/.test(filePath) && existsSync(bin("eslint"))) {
  try {
    run("eslint", ["--fix", "--no-warn-ignored", filePath]);
  } catch (error) {
    const details = [error.stdout, error.stderr].filter(Boolean).join("\n") || error.message;
    console.error(`ESLint found problems in ${filePath}:\n${details}`);
    process.exit(2);
  }
}
