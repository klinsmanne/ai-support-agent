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
const OLD_OPEN = "00000000-0000-4000-8000-00000000c003";
const OLD_BUT_ACTIVE = "00000000-0000-4000-8000-00000000c004";
const USER = "00000000-0000-4000-8000-00000000c0ff";

let db: PGlite;
const n = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(seedSql());
}, 60_000);

describe("purge_expired_data (retention)", () => {
  it("deletes tickets past the tenant's retention with their messages, and nothing newer", async () => {
    await db.exec(`
      insert into public.tickets (id, tenant_id, channel, subject, status, created_at, updated_at) values
        ('${OLD}', '${HARBOR}', 'email', 'old', 'resolved', now() - interval '200 days', now() - interval '200 days'),
        ('${FRESH}', '${HARBOR}', 'email', 'fresh', 'resolved', now() - interval '2 days', now() - interval '2 days'),
        ('${OLD_OPEN}', '${HARBOR}', 'email', 'old escalated', 'escalated', now() - interval '200 days', now() - interval '200 days'),
        ('${OLD_BUT_ACTIVE}', '${HARBOR}', 'email', 'old row, new message', 'resolved', now() - interval '200 days', now() - interval '200 days');
      insert into public.messages (tenant_id, ticket_id, direction, author, status, body, created_at) values
        ('${HARBOR}', '${OLD}', 'inbound', 'customer', 'received', 'old text', now() - interval '200 days'),
        ('${HARBOR}', '${FRESH}', 'inbound', 'customer', 'received', 'fresh text', now()),
        ('${HARBOR}', '${OLD_BUT_ACTIVE}', 'inbound', 'customer', 'received', 'follow-up', now() - interval '1 day');
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
    // Waiting for a human, or with a recent follow-up: kept however old the ticket row is.
    expect(await n(`select count(*)::int n from public.tickets where id = '${OLD_OPEN}'`)).toBe(1);
    expect(
      await n(`select count(*)::int n from public.tickets where id = '${OLD_BUT_ACTIVE}'`),
    ).toBe(1);
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
    await db.exec(`insert into auth.users (id, email) values ('${USER}', 'u@x.example')
      on conflict do nothing;`);
    for (const fn of ["purge_expired_data", "reset_demo_data"]) {
      await expect(asUser(db, USER, `select public.${fn}()`)).rejects.toThrow(/permission denied/);
    }
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

describe("seed", () => {
  it("is idempotent: running it twice leaves the same demo data", async () => {
    const snapshot = async () =>
      (
        await db.query<{ o: number; p: number; c: number }>(
          `select (select count(*)::int from public.orders) o, (select count(*)::int from public.payments) p,
                  (select count(*)::int from public.customers) c`,
        )
      ).rows[0];
    const before = await snapshot();
    await db.exec(seedSql());
    expect(await snapshot()).toEqual(before);
  });

  it("marks only the configured demo tenants as demo", async () => {
    const res = await db.query<{ slug: string }>(
      "select slug from public.tenants where is_demo order by slug",
    );
    expect(res.rows.map((r) => r.slug)).toEqual(["cadence-analytics", "harbor-pine"]);
  });
});
