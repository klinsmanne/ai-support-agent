import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { stableUuid } from "@/lib/tenants/seed-sql";
import { asUser, createTestDb, seedSql } from "./harness";

const HARBOR = stableUuid("tenant", "harbor-pine");
const CADENCE = stableUuid("tenant", "cadence-analytics");
const HARBOR_OWNER = "00000000-0000-4000-8000-000000000001";
const HARBOR_VIEWER = "00000000-0000-4000-8000-000000000002";
const CADENCE_AGENT = "00000000-0000-4000-8000-000000000003";

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(seedSql());
  await db.exec(`
    insert into auth.users (id, email) values
      ('${HARBOR_OWNER}', 'owner@harbor.example'),
      ('${HARBOR_VIEWER}', 'viewer@harbor.example'),
      ('${CADENCE_AGENT}', 'agent@cadence.example');
    insert into public.tenant_members (tenant_id, user_id, role) values
      ('${HARBOR}', '${HARBOR_OWNER}', 'owner'),
      ('${HARBOR}', '${HARBOR_VIEWER}', 'viewer'),
      ('${CADENCE}', '${CADENCE_AGENT}', 'agent');
    insert into public.tickets (id, tenant_id, channel, subject) values
      (gen_random_uuid(), '${HARBOR}', 'email', 'Where is my order?'),
      (gen_random_uuid(), '${CADENCE}', 'chat', 'Billing question');
  `);
}, 60_000);

const count = async (userId: string | null, table: string, tenantId?: string) => {
  const where = tenantId ? ` where tenant_id = '${tenantId}'` : "";
  const res = await asUser<{ n: number }>(
    db,
    userId,
    `select count(*)::int as n from public.${table}${where}`,
  );
  return res.rows[0].n;
};

describe("seed data", () => {
  it("loads both tenants", async () => {
    const res = await db.query<{ slug: string }>("select slug from public.tenants order by slug");
    expect(res.rows.map((r) => r.slug)).toEqual(["cadence-analytics", "harbor-pine"]);
  });

  it("is idempotent — re-running the seed does not duplicate rows", async () => {
    const before = await db.query<{ n: number }>("select count(*)::int as n from public.orders");
    await db.exec(seedSql());
    const after = await db.query<{ n: number }>("select count(*)::int as n from public.orders");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("seeds a double charge for order 1051", async () => {
    const res = await db.query<{ n: number }>(
      `select count(*)::int as n from public.payments p join public.orders o on o.id = p.order_id
       where o.tenant_id = $1 and o.order_number = '1051'`,
      [HARBOR],
    );
    expect(res.rows[0].n).toBe(2);
  });
});

describe("row level security — tenant isolation", () => {
  it.each(["customers", "orders", "payments", "tickets", "kb_documents", "tenant_settings"])(
    "a Harbor member sees only Harbor rows in %s",
    async (table) => {
      expect(await count(HARBOR_OWNER, table, CADENCE)).toBe(0);
      expect(await count(HARBOR_OWNER, table, HARBOR)).toBeGreaterThan(0);
    },
  );

  it("a Cadence member cannot read Harbor customers", async () => {
    expect(await count(CADENCE_AGENT, "customers", HARBOR)).toBe(0);
    expect(await count(CADENCE_AGENT, "customers", CADENCE)).toBe(3);
  });

  it("anonymous users cannot read any table", async () => {
    await expect(count(null, "customers")).rejects.toThrow(/permission denied/);
    await expect(count(null, "tickets")).rejects.toThrow(/permission denied/);
  });

  it("users without membership see nothing", async () => {
    const stranger = "00000000-0000-4000-8000-0000000000ff";
    expect(await count(stranger, "customers")).toBe(0);
    expect(await count(stranger, "tenants")).toBe(0);
  });

  it("a Cadence agent cannot update Harbor tickets", async () => {
    const res = await asUser(
      db,
      CADENCE_AGENT,
      `update public.tickets set status = 'closed' where tenant_id = $1`,
      [HARBOR],
    );
    expect(res.affectedRows).toBe(0);
  });

  it("only owners can change tenant settings", async () => {
    const viewer = await asUser(
      db,
      HARBOR_VIEWER,
      `update public.tenant_settings set kill_switch = true where tenant_id = $1`,
      [HARBOR],
    );
    expect(viewer.affectedRows).toBe(0);
    const owner = await asUser(
      db,
      HARBOR_OWNER,
      `update public.tenant_settings set kill_switch = true where tenant_id = $1`,
      [HARBOR],
    );
    expect(owner.affectedRows).toBe(1);
  });

  it("dashboard users cannot insert refunds directly (only the backend can)", async () => {
    await expect(
      asUser(
        db,
        HARBOR_OWNER,
        `insert into public.refunds (tenant_id, order_id, customer_id, amount_cents, reason, status, decided_by, idempotency_key)
         select tenant_id, id, customer_id, 100, 'x', 'approved', 'human', 'k1' from public.orders where tenant_id = $1 limit 1`,
        [HARBOR],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("composite keys stop an order being attached to another tenant's customer", async () => {
    await expect(
      db.query(
        `insert into public.orders (tenant_id, customer_id, order_number, status, total_cents)
         select $1, id, 'X-1', 'pending', 100 from public.customers where tenant_id = $2 limit 1`,
        [HARBOR, CADENCE],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("knowledge base retrieval", () => {
  it("hybrid search only returns the requested tenant's chunks", async () => {
    // Deterministic fake embeddings: retrieval logic is under test here, not embedding quality.
    await db.exec(
      `update public.kb_chunks set embedding = array_fill(0.01::real, array[768])::extensions.vector`,
    );
    const query = `select title, slug from public.match_kb_chunks($1, array_fill(0.01::real, array[768])::extensions.vector, $2, 5)`;
    const harbor = await db.query<{ slug: string; content: string }>(
      query.replace("title, slug", "title, slug, content"),
      [HARBOR, "return sale items"],
    );
    // With identical fake embeddings only the keyword leg discriminates, so assert top-3 recall
    // rather than exact order; ranking quality with real embeddings is measured by the eval suite.
    const top3 = harbor.rows.slice(0, 3);
    expect(top3.some((r) => r.slug === "returns-policy" && r.content.includes("final sale"))).toBe(
      true,
    );

    const cadenceSlugs = new Set([
      "account-security",
      "billing-and-refunds",
      "bugs-and-status",
      "data-export",
      "plans-and-seats",
    ]);
    const cadence = await db.query<{ slug: string }>(query, [CADENCE, "return sale items"]);
    expect(cadence.rows.every((r) => cadenceSlugs.has(r.slug))).toBe(true);
  });

  it("dashboard users cannot call the retrieval function directly", async () => {
    await expect(
      asUser(
        db,
        HARBOR_OWNER,
        `select * from public.match_kb_chunks($1, array_fill(0.01::real, array[768])::extensions.vector, 'x', 5)`,
        [CADENCE],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
