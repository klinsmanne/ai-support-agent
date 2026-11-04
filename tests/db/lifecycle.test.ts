import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { stableUuid } from "@/lib/tenants/seed-sql";
import { asUser, createTestDb, seedSql } from "./harness";

const HARBOR = stableUuid("tenant", "harbor-pine");
const ORDER_1051 = stableUuid("order", "harbor-pine", "1051");
const ORDER_1060 = stableUuid("order", "harbor-pine", "1060");
const MARCUS = stableUuid("customer", "harbor-pine", "marcus");
const OLD = "00000000-0000-4000-8000-00000000c001";
const FRESH = "00000000-0000-4000-8000-00000000c002";

let db: PGlite;
const n = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(seedSql());
}, 60_000);

describe("purge_expired_data (retention)", () => {
  it("deletes tickets past the tenant's retention with their messages, and nothing newer", async () => {
    await db.exec(`
      insert into public.tickets (id, tenant_id, channel, subject, created_at, updated_at) values
        ('${OLD}', '${HARBOR}', 'email', 'old', now() - interval '200 days', now() - interval '200 days'),
        ('${FRESH}', '${HARBOR}', 'email', 'fresh', now() - interval '2 days', now() - interval '2 days');
      insert into public.messages (tenant_id, ticket_id, direction, author, status, body) values
        ('${HARBOR}', '${OLD}', 'inbound', 'customer', 'received', 'old text'),
        ('${HARBOR}', '${FRESH}', 'inbound', 'customer', 'received', 'fresh text');
      insert into public.refunds (tenant_id, order_id, customer_id, ticket_id, amount_cents, reason, status, decided_by, idempotency_key)
        values ('${HARBOR}', '${ORDER_1051}', '${MARCUS}', '${OLD}', 100, 'duplicate_charge', 'approved', 'ai', 'purge-test');
      insert into public.chat_sessions (tenant_id, ip_hash, last_seen_at) values
        ('${HARBOR}', 'x', now() - interval '30 days'), ('${HARBOR}', 'y', now());
    `);
    const res = await db.query<{ r: Record<string, number> }>(
      "select public.purge_expired_data() as r",
    );
    expect(res.rows[0].r.tickets).toBe(1);
    expect(await n(`select count(*)::int n from public.tickets where id = '${OLD}'`)).toBe(0);
    expect(await n(`select count(*)::int n from public.tickets where id = '${FRESH}'`)).toBe(1);
    expect(await n(`select count(*)::int n from public.messages where ticket_id = '${OLD}'`)).toBe(
      0,
    );
    expect(
      await n(`select count(*)::int n from public.messages where ticket_id = '${FRESH}'`),
    ).toBe(1);
    // The financial record survives, detached from the deleted conversation.
    expect(
      await n(
        `select count(*)::int n from public.refunds where idempotency_key = 'purge-test' and ticket_id is null`,
      ),
    ).toBe(1);
    expect(await n(`select count(*)::int n from public.chat_sessions where ip_hash = 'x'`)).toBe(0);
    expect(await n(`select count(*)::int n from public.chat_sessions where ip_hash = 'y'`)).toBe(1);
  });

  it("can't be called by dashboard users or anonymously", async () => {
    await expect(asUser(db, null, "select public.purge_expired_data()")).rejects.toThrow(
      /permission denied/,
    );
    await expect(asUser(db, null, "select public.reset_demo_data()")).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("reset_demo_data (shared public demo)", () => {
  it("restores scripted orders and clears refunds so sample scenarios keep working", async () => {
    await db.exec(`
      update public.orders set shipping_address = '{"line1":"changed"}'::jsonb where id = '${ORDER_1060}';
      insert into public.refunds (tenant_id, order_id, customer_id, amount_cents, reason, status, decided_by, idempotency_key)
        values ('${HARBOR}', '${ORDER_1051}', '${MARCUS}', 6400, 'duplicate_charge', 'approved', 'ai', 'visitor-1');
    `);
    await db.exec("select public.reset_demo_data()");
    expect(
      await n(`select count(*)::int n from public.refunds where tenant_id = '${HARBOR}'`),
    ).toBe(0);
    const addr = await db.query<{ a: Record<string, string> }>(
      `select shipping_address a from public.orders where id = '${ORDER_1060}'`,
    );
    expect(addr.rows[0].a.line1).not.toBe("changed");
    // Payments (incl. the scripted duplicate charge) are back.
    expect(
      await n(`select count(*)::int n from public.payments where order_id = '${ORDER_1051}'`),
    ).toBe(2);
  });
});
