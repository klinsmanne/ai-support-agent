import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TenantConfigSchema, type TenantConfig } from "./config.ts";

/** Loads and validates every tenants/<slug>/ folder (config + KB markdown). Node-only (scripts, tests, evals). */
export function loadTenantFolders(
  tenantsDir: string,
): { config: TenantConfig; kb: { slug: string; markdown: string }[] }[] {
  return readdirSync(tenantsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(tenantsDir, d.name, "tenant.json")))
    .map((d) => {
      const config = TenantConfigSchema.parse(
        JSON.parse(readFileSync(join(tenantsDir, d.name, "tenant.json"), "utf8")),
      );
      const kbDir = join(tenantsDir, d.name, "kb");
      const kb = existsSync(kbDir)
        ? readdirSync(kbDir)
            .filter((f) => f.endsWith(".md"))
            .sort()
            .map((f) => ({
              slug: f.replace(/\.md$/, ""),
              markdown: readFileSync(join(kbDir, f), "utf8"),
            }))
        : [];
      return { config, kb };
    });
}
