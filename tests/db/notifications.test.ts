import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { stableUuid } from "@/lib/tenants/seed-sql";
import { createTestDb, seedSql } from "./harness";

const HARBOR = stableUuid("tenant", "harbor-pine");
let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(seedSql());
}, 60_000);

describe("escalation notification settings (migration 14)", () => {
  it("defaults to off (no address) with the digest enabled", async () => {
    const { rows } = await db.query<{ e: string | null; d: boolean }>(
      `select escalation_notify_email e, escalation_digest d from public.tenant_settings where tenant_id = '${HARBOR}'`,
    );
    expect(rows[0]).toEqual({ e: null, d: true });
  });

  it("accepts an email address and rejects anything else", async () => {
    await db.exec(
      `update public.tenant_settings set escalation_notify_email = 'team@client.example' where tenant_id = '${HARBOR}'`,
    );
    await expect(
      db.exec(
        `update public.tenant_settings set escalation_notify_email = 'not an email' where tenant_id = '${HARBOR}'`,
      ),
    ).rejects.toThrow();
    await db.exec(
      `update public.tenant_settings set escalation_notify_email = null where tenant_id = '${HARBOR}'`,
    );
  });

  it("only pg_cron (postgres) can trigger the digest", async () => {
    const { rows } = await db.query<Record<string, boolean>>(`
      select
        has_function_privilege('anon', 'public.trigger_escalation_digest()', 'execute') as anon,
        has_function_privilege('authenticated', 'public.trigger_escalation_digest()', 'execute') as auth,
        has_function_privilege('service_role', 'public.trigger_escalation_digest()', 'execute') as svc`);
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: false });
  });
});
