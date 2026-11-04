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

  it("is idempotent — re-running the seed keeps counts and existing embeddings", async () => {
    const snapshot = async () =>
      (
        await db.query<Record<string, number>>(`select
          (select count(*)::int from public.customers) customers,
          (select count(*)::int from public.orders) orders,
          (select count(*)::int from public.payments) payments,
          (select count(*)::int from public.kb_documents) docs,
          (select count(*)::int from public.kb_chunks) chunks,
          (select count(*)::int from public.kb_chunks where embedding is not null) embedded`)
      ).rows[0];
    await db.exec(
      `update public.kb_chunks set embedding = array_fill(0.02::real, array[768])::extensions.vector`,
    );
    const before = await snapshot();
    await db.exec(seedSql());
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.embedded).toBe(after.chunks); // unchanged chunks keep their embeddings
  });

  it("prunes rows that were removed from the tenant config", async () => {
    await db.exec(
      `insert into public.kb_documents (tenant_id, slug, title, content) values ('${HARBOR}', 'stale', 'Stale', 'x')`,
    );
    await db.exec(seedSql());
    const res = await db.query<{ n: number }>(
      `select count(*)::int as n from public.kb_documents where slug = 'stale'`,
    );
    expect(res.rows[0].n).toBe(0);
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

  // Dashboard users are read-only in the database; all changes go through validated server routes.
  it.each([
    [
      "another tenant's tickets",
      CADENCE_AGENT,
      `update public.tickets set status = 'closed' where tenant_id = '${HARBOR}'`,
    ],
    [
      "their own tenant's tickets",
      HARBOR_OWNER,
      `update public.tickets set sender_verified = true where tenant_id = '${HARBOR}'`,
    ],
    [
      "settings, even as owner",
      HARBOR_OWNER,
      `update public.tenant_settings set refund_auto_approve_limit_cents = 99999999`,
    ],
    [
      "escalation pending actions",
      HARBOR_OWNER,
      `update public.escalations set status = 'approved'`,
    ],
    [
      "refunds",
      HARBOR_OWNER,
      `insert into public.refunds (tenant_id, order_id, customer_id, amount_cents, reason, status, decided_by, idempotency_key)
       select tenant_id, id, customer_id, 100, 'x', 'approved', 'human', 'k1' from public.orders limit 1`,
    ],
    ["the audit log", HARBOR_OWNER, `delete from public.audit_log`],
    ["tenant membership", HARBOR_VIEWER, `update public.tenant_members set role = 'owner'`],
  ])("dashboard users cannot write %s", async (_label, user, sql) => {
    await expect(asUser(db, user, sql)).rejects.toThrow(/permission denied/);
  });

  it("settings constraints hold even for the backend (defense in depth)", async () => {
    await expect(
      db.query(
        `update public.tenant_settings set refund_auto_approve_limit_cents = 99999999 where tenant_id = $1`,
        [HARBOR],
      ),
    ).rejects.toThrow(/refund_limit_cap/);
    await expect(
      db.query(
        `update public.tenant_settings set enabled_tools = array['get_customer'] where tenant_id = $1`,
        [HARBOR],
      ),
    ).rejects.toThrow(/escalation_always_enabled/);
    await expect(
      db.query(
        `update public.tenant_settings set enabled_tools = array['escalate_to_human','run_sql'] where tenant_id = $1`,
        [HARBOR],
      ),
    ).rejects.toThrow(/known_tools/);
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
    // Keyword-only (null embedding) ranking is deterministic: the sale-items section should win.
    // Ranking quality with real embeddings is measured by the eval suite, not here.
    const keywordOnly = await db.query<{ slug: string; content: string }>(
      `select slug, content from public.match_kb_chunks($1, null, $2, 5)`,
      [HARBOR, "can I return sale items"],
    );
    expect(keywordOnly.rows[0].slug).toBe("returns-policy");
    expect(keywordOnly.rows[0].content).toContain("final sale");

    // Hybrid mode with fake embeddings: every result must still belong to the tenant.
    const harbor = await db.query<{ slug: string }>(query, [HARBOR, "return sale items"]);
    const harborSlugs = new Set([
      "contact-and-hours",
      "damaged-items",
      "order-changes",
      "refunds-and-billing",
      "returns-policy",
      "shipping-policy",
    ]);
    expect(harbor.rows.length).toBeGreaterThan(0);
    expect(harbor.rows.every((r) => harborSlugs.has(r.slug))).toBe(true);

    const cadenceSlugs = new Set([
      "account-security",
      "billing-and-refunds",
      "bugs-and-status",
      "data-export",
      "plans-and-seats",
    ]);
    const cadence = await db.query<{ slug: string }>(query, [CADENCE, "return sale items"]);
    expect(cadence.rows.length).toBeGreaterThan(0); // guard against a vacuous every()
    expect(cadence.rows.every((r) => cadenceSlugs.has(r.slug))).toBe(true);
  });

  it("matches inflected words (query terms are stemmed exactly once)", async () => {
    // "refunded" and "refunds" must both reach chunks containing "refund"; with double stemming they didn't.
    const res = await db.query<{ slug: string }>(
      `select slug from public.match_kb_chunks($1, null, $2, 5)`,
      [CADENCE, "refunded duplicates"],
    );
    expect(res.rows.map((r) => r.slug)).toContain("billing-and-refunds");
  });

  it.each([
    "",
    "   ",
    "C:\\path\\file",
    'it\'s "quoted" & | ! (odd)',
    "¿Puedo devolver artículos?",
  ])("keyword search tolerates arbitrary query text: %j", async (text) => {
    await expect(
      db.query(
        `select * from public.match_kb_chunks($1, array_fill(0.01::real, array[768])::extensions.vector, $2, 5)`,
        [HARBOR, text],
      ),
    ).resolves.toBeDefined();
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

describe("create_refund_checked (atomic refund)", () => {
  const refund = (key: string, amount: number, max = 5) =>
    db.query<{ refund_id: string | null; outcome: string }>(
      `select r.* from public.orders o,
         public.create_refund_checked($1, o.id, o.customer_id, null, $2, 'duplicate_charge', 'approved', $3, $4) r
       where o.tenant_id = $1 and o.order_number = '1051'`,
      [HARBOR, amount, key, max],
    );

  it("creates, then dedupes on the same idempotency key", async () => {
    expect((await refund("k-a", 6400)).rows[0].outcome).toBe("created");
    expect((await refund("k-a", 6400)).rows[0].outcome).toBe("duplicate");
  });

  it("refuses to refund more than was captured, whatever the caller claims", async () => {
    // 1051 has two captured charges of 6400 = 12800 total; 6400 already refunded above.
    expect((await refund("k-b", 6401)).rows[0].outcome).toBe("exceeds_balance");
    expect((await refund("k-c", 6400)).rows[0].outcome).toBe("created");
    expect((await refund("k-d", 1)).rows[0].outcome).toBe("exceeds_balance");
  });

  it("enforces the 30-day frequency limit inside the transaction", async () => {
    await db.exec(`delete from public.refunds`);
    expect((await refund("k-e", 100, 1)).rows[0].outcome).toBe("created");
    expect((await refund("k-f", 100, 1)).rows[0].outcome).toBe("frequency_limit");
  });

  it("is not callable by dashboard users", async () => {
    await expect(
      asUser(
        db,
        HARBOR_OWNER,
        `select public.create_refund_checked('${HARBOR}', gen_random_uuid(), gen_random_uuid(), null, 1, 'x', 'approved', 'k', 5)`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("dashboard_metrics", () => {
  it("computes KPIs for members and returns nothing of another tenant's", async () => {
    await db.exec(`
      insert into public.tickets (id, tenant_id, channel, status, created_at, first_response_at, is_spam) values
        ('00000000-0000-4000-8000-00000000a001', '${HARBOR}', 'email', 'resolved', now() - interval '1 hour', now() - interval '59 minutes', false),
        ('00000000-0000-4000-8000-00000000a002', '${HARBOR}', 'email', 'escalated', now() - interval '1 hour', null, false),
        ('00000000-0000-4000-8000-00000000a003', '${HARBOR}', 'email', 'closed', now(), null, true);
      insert into public.messages (tenant_id, ticket_id, direction, author, status, body) values
        ('${HARBOR}', '00000000-0000-4000-8000-00000000a001', 'outbound', 'ai', 'sent', 'answer');
      insert into public.escalations (tenant_id, ticket_id, reason_codes, summary) values
        ('${HARBOR}', '00000000-0000-4000-8000-00000000a002', array['customer_requested_human'], 'x');
    `);
    const q = `select public.dashboard_metrics($1, 30) as m`;
    const mine = (await asUser<{ m: Record<string, number> }>(db, HARBOR_OWNER, q, [HARBOR]))
      .rows[0].m;
    expect(mine).toMatchObject({
      auto_resolved: 1,
      escalated: 1,
      spam_closed: 1,
      median_first_response_seconds: 60,
    });
    expect(mine.handled).toBeGreaterThanOrEqual(3); // includes isolation-test tickets created earlier
    const theirs = (await asUser<{ m: Record<string, number> }>(db, CADENCE_AGENT, q, [HARBOR]))
      .rows[0].m;
    expect(theirs).toMatchObject({ tickets_total: 0, auto_resolved: 0 });
  });

  it("counts only approved drafts as assisted and keeps spam out of risk KPIs (v2)", async () => {
    const before = (
      await asUser<{ m: Record<string, number> }>(
        db,
        HARBOR_OWNER,
        `select public.dashboard_metrics($1, 30) as m`,
        [HARBOR],
      )
    ).rows[0].m;
    await db.exec(`
      insert into public.tickets (id, tenant_id, channel, status, is_spam, injection_suspected) values
        ('00000000-0000-4000-8000-00000000a011', '${HARBOR}', 'email', 'resolved', false, false),
        ('00000000-0000-4000-8000-00000000a012', '${HARBOR}', 'email', 'escalated', false, false),
        ('00000000-0000-4000-8000-00000000a013', '${HARBOR}', 'email', 'closed', true, true);
      insert into public.escalations (tenant_id, ticket_id, reason_codes, summary, status) values
        ('${HARBOR}', '00000000-0000-4000-8000-00000000a011', array['draft_review'], 'x', 'approved'),
        ('${HARBOR}', '00000000-0000-4000-8000-00000000a012', array['draft_review'], 'x', 'rejected');
    `);
    const after = (
      await asUser<{ m: Record<string, number> }>(
        db,
        HARBOR_OWNER,
        `select public.dashboard_metrics($1, 30) as m`,
        [HARBOR],
      )
    ).rows[0].m;
    expect(after.assisted - before.assisted).toBe(1); // the rejected draft doesn't count
    expect(after.escalated - before.escalated).toBe(0); // draft review alone isn't an escalation
    expect(after.injection_flagged - before.injection_flagged).toBe(0); // spam excluded
  });

  it("is not callable anonymously", async () => {
    await expect(
      asUser(db, null, `select public.dashboard_metrics('${HARBOR}', 30)`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("viewer privacy (public demo account)", () => {
  const REAL = "00000000-0000-4000-8000-00000000b001";
  const DEMO = "00000000-0000-4000-8000-00000000b002";
  const CHAT = "00000000-0000-4000-8000-00000000b003";
  beforeAll(async () => {
    await db.exec(`
      insert into public.tickets (id, tenant_id, channel, subject, requester_email, customer_id) values
        ('${REAL}', '${HARBOR}', 'email', 'from a real person', 'someone@real.example', null),
        ('${DEMO}', '${HARBOR}', 'email', 'fictional customer', 'olivia.bennett@example.com', (select id from public.customers where tenant_id = '${HARBOR}' limit 1)),
        ('${CHAT}', '${HARBOR}', 'chat', 'Website chat', null, null);
      insert into public.messages (tenant_id, ticket_id, direction, author, status, body) values
        ('${HARBOR}', '${REAL}', 'inbound', 'customer', 'received', 'my real private message');
      insert into public.audit_log (tenant_id, actor_type, action, entity_type, entity_id) values
        ('${HARBOR}', 'system', 'x', 'ticket', '${REAL}');
    `);
  });

  const visible = async (user: string, sql: string) =>
    (await asUser<{ n: number }>(db, user, sql)).rows[0].n;

  it("viewers can't read real senders' tickets or messages, but see demo customers and chat", async () => {
    const ids = `('${REAL}','${DEMO}','${CHAT}')`;
    expect(
      await visible(HARBOR_VIEWER, `select count(*)::int n from public.tickets where id in ${ids}`),
    ).toBe(2);
    expect(
      await visible(
        HARBOR_VIEWER,
        `select count(*)::int n from public.tickets where id = '${REAL}'`,
      ),
    ).toBe(0);
    expect(
      await visible(
        HARBOR_VIEWER,
        `select count(*)::int n from public.messages where ticket_id = '${REAL}'`,
      ),
    ).toBe(0);
  });

  it("owners still see every ticket of their tenant", async () => {
    expect(
      await visible(
        HARBOR_OWNER,
        `select count(*)::int n from public.tickets where id in ('${REAL}','${DEMO}','${CHAT}')`,
      ),
    ).toBe(3);
  });

  it("the audit log is staff-only", async () => {
    expect(await visible(HARBOR_VIEWER, `select count(*)::int n from public.audit_log`)).toBe(0);
    expect(
      await visible(HARBOR_OWNER, `select count(*)::int n from public.audit_log`),
    ).toBeGreaterThan(0);
  });
});
