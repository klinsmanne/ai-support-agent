import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { stableUuid } from "@/lib/tenants/seed-sql";
import { createTestDb, seedSql } from "./harness";

const HARBOR = stableUuid("tenant", "harbor-pine");
let db: PGlite;
const claim = async (seconds = 330) =>
  (
    await db.query<{ ok: boolean }>(
      `select public.claim_channel_lease('${HARBOR}', 'email', ${seconds}) as ok`,
    )
  ).rows[0].ok;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(seedSql());
}, 60_000);

describe("claim_channel_lease (one Gmail poll at a time)", () => {
  it("lets one poll in, refuses an overlapping one, and frees the lease on release", async () => {
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false); // the overlapping pg_cron run does nothing
    await db.query(`select public.release_channel_lease('${HARBOR}', 'email')`);
    expect(await claim()).toBe(true);
    await db.query(`select public.release_channel_lease('${HARBOR}', 'email')`);
  });

  it("an expired lease (crashed poll) can be claimed again", async () => {
    expect(await claim(1)).toBe(true);
    await db.query(
      `update public.channel_state set lease_until = now() - interval '1 second'
       where tenant_id = '${HARBOR}' and channel = 'email'`,
    );
    expect(await claim()).toBe(true);
    await db.query(`select public.release_channel_lease('${HARBOR}', 'email')`);
  });

  it("keeps the poll's saved state (cursor, queue) untouched", async () => {
    await db.exec(
      `insert into public.channel_state (tenant_id, channel, state) values ('${HARBOR}', 'email', '{"historyId":"42"}')
       on conflict (tenant_id, channel) do update set state = excluded.state`,
    );
    expect(await claim()).toBe(true);
    const { rows } = await db.query<{ state: { historyId: string } }>(
      `select state from public.channel_state where tenant_id = '${HARBOR}' and channel = 'email'`,
    );
    expect(rows[0].state.historyId).toBe("42");
  });

  it("only the server (service role) may call it", async () => {
    const { rows } = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      select
        has_function_privilege('anon', 'public.claim_channel_lease(uuid, public.channel_type, integer)', 'execute') as anon,
        has_function_privilege('authenticated', 'public.claim_channel_lease(uuid, public.channel_type, integer)', 'execute') as auth,
        has_function_privilege('service_role', 'public.claim_channel_lease(uuid, public.channel_type, integer)', 'execute') as svc`);
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });
});
