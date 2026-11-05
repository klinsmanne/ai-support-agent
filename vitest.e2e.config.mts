import { defineConfig } from "vitest/config";

// Live-site smoke tests (tests/e2e/*.e2e.ts): separate from `npm test`, which must stay offline.
export default defineConfig({
  test: { environment: "node", include: ["tests/e2e/**/*.e2e.ts"], testTimeout: 30_000 },
});
