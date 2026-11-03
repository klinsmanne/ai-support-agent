import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const HOOK = ".claude/hooks/protect-secrets.mjs";

// Runs the hook the way Claude Code does: JSON on stdin, exit code 2 = blocked.
function runHook(payload: unknown): number | null {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  return spawnSync("node", [HOOK], { input, encoding: "utf8" }).status;
}

const secretEnv = [".env", "local"].join("."); // built at runtime so this file never names it literally

describe("protect-secrets hook", () => {
  it.each([
    ["Read", { file_path: `/app/${secretEnv}` }],
    ["Edit", { file_path: "/app/keys/server.pem" }],
    ["Write", { file_path: "/app/client_secret_123.json" }],
    ["Bash", { command: `cat ${secretEnv}` }],
    ["Bash", { command: "grep KEY .env*" }],
    ["Bash", { command: `node -e "require('fs').readFileSync('${secretEnv}')"` }],
  ])("blocks %s on secret files: %j", (tool_name, tool_input) => {
    expect(runHook({ tool_name, tool_input })).toBe(2);
  });

  it.each([
    ["Read", { file_path: "/app/.env.example" }],
    ["Edit", { file_path: "/app/src/app/page.tsx" }],
    ["Bash", { command: "npm test" }],
    // Code identifiers that merely look like key files are not secret-file access.
    ["Bash", { command: "node -e 'const k = c.key; const p = cert.pem'" }],
  ])("allows %s on normal files: %j", (tool_name, tool_input) => {
    expect(runHook({ tool_name, tool_input })).toBe(0);
  });

  it("fails closed on unreadable input", () => {
    expect(runHook("not json")).toBe(2);
  });
});
