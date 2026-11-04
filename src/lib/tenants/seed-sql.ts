import { createHash } from "node:crypto";
import type { TenantConfig } from "./config.ts";
import { chunkMarkdown } from "../rag/chunk.ts";

/** Deterministic UUID from stable keys, so re-running the seed upserts instead of duplicating. */
export function stableUuid(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type SqlValue = string | number | boolean | null | undefined | object;

/** Render a value as a SQL literal. Strings are single-quote escaped; objects become jsonb. */
export function lit(value: SqlValue): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in seed");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  return `${lit(JSON.stringify(value))}::jsonb`;
}

const textArray = (values: string[]) =>
  values.length ? `array[${values.map(lit).join(", ")}]::text[]` : "array[]::text[]";
const uuidArray = (ids: string[]) => `array[${ids.map(lit).join(", ")}]::uuid[]`;
const daysAgo = (n: number | undefined) =>
  n === undefined ? "null" : `now() - interval '${n} days'`;
const dateIn = (n: number | undefined) => (n === undefined ? "null" : `current_date + ${n}`);

export interface KbDoc {
  slug: string;
  markdown: string;
}

/** Builds idempotent seed SQL (upserts) for one tenant: settings, customers, orders, payments, KB. */
/**
 * Seed SQL for one tenant, in three parts:
 *  - setup: tenant, settings, customers, KB (run once per seed)
 *  - reset: orders, payments, and removal of refunds — the demo's mutable state. build-seed wraps
 *    every tenant's reset in public.reset_demo_data(), which the seed calls and pg_cron re-runs
 *    daily, so the shared public demo's sample refunds and address changes keep working.
 *  - cleanup: rows removed from the config (customers last: orders reference them)
 */
export interface TenantSeedSql {
  setup: string;
  reset: string;
  cleanup: string;
}

export function buildTenantSeedSql(cfg: TenantConfig, kbDocs: KbDoc[]): TenantSeedSql {
  const tenantId = stableUuid("tenant", cfg.slug);
  const s = cfg.settings;
  // Only the regex-validated slug goes into the SQL comment; free text could contain a newline.
  const out: string[] = [`-- Tenant: ${cfg.slug}`];

  out.push(
    `insert into public.tenants (id, slug, name, industry, is_demo) values (${lit(tenantId)}, ${lit(cfg.slug)}, ${lit(cfg.name)}, ${lit(cfg.industry)}, ${lit(cfg.demo)})
  on conflict (id) do update set name = excluded.name, industry = excluded.industry, is_demo = excluded.is_demo;`,
  );

  out.push(
    `insert into public.tenant_settings (tenant_id, rollout_mode, refund_auto_approve_limit_cents, max_refunds_per_customer_30d,
  escalate_on_negative_sentiment_below, min_confidence_to_act, enabled_tools, brand_name, brand_voice, supported_languages,
  allowed_link_domains, support_email, csat_enabled, daily_ticket_cap, max_ai_replies_per_thread, retention_days)
values (${lit(tenantId)}, ${lit(s.rollout_mode)}, ${lit(s.refund_auto_approve_limit_cents)}, ${lit(s.max_refunds_per_customer_30d)},
  ${lit(s.escalate_on_negative_sentiment_below)}, ${lit(s.min_confidence_to_act)}, ${textArray(s.enabled_tools)}, ${lit(s.brand_name)},
  ${lit(s.brand_voice)}, ${textArray(s.supported_languages)}, ${textArray(s.allowed_link_domains)}, ${lit(s.support_email)},
  ${lit(s.csat_enabled)}, ${lit(s.daily_ticket_cap)}, ${lit(s.max_ai_replies_per_thread)}, ${lit(s.retention_days)})
on conflict (tenant_id) do nothing; -- settings changed in the dashboard are never overwritten by re-seeding`,
  );

  const reset: string[] = [
    `-- Tenant: ${cfg.slug}`,
    // Refunds are demo activity (visitors trying the scenarios); seeded orders start un-refunded.
    `delete from public.refunds where tenant_id = ${lit(tenantId)};`,
  ];
  const cleanup: string[] = [];
  const customerIds = new Map<string, string>();
  for (const c of cfg.customers) {
    const id = stableUuid("customer", cfg.slug, c.key);
    customerIds.set(c.key, id);
    out.push(
      `insert into public.customers (id, tenant_id, email, name, preferred_language, plan) values (${lit(id)}, ${lit(tenantId)}, ${lit(c.email)}, ${lit(c.name)}, ${lit(c.preferred_language)}, ${lit(c.plan)})
  on conflict (id) do update set email = excluded.email, name = excluded.name, preferred_language = excluded.preferred_language, plan = excluded.plan;`,
    );
  }

  // Demo tenants: orders/payments go into the daily reset (upsert to the scripted state). Real
  // tenants: inserted once if missing, never overwritten or deleted by a re-seed.
  const orderSql: string[] = cfg.demo ? reset : out;
  const keep = (sql: string) =>
    cfg.demo
      ? sql
      : sql.replace(/on conflict \(id\) do update set[\s\S]*;$/, "on conflict (id) do nothing;");
  for (const o of cfg.orders) {
    const orderId = stableUuid("order", cfg.slug, o.order_number);
    const customerId = customerIds.get(o.customer)!;
    orderSql.push(
      keep(`insert into public.orders (id, tenant_id, customer_id, order_number, status, currency, total_cents, items, shipping_address,
  carrier, tracking_number, estimated_delivery, placed_at, shipped_at, delivered_at)
values (${lit(orderId)}, ${lit(tenantId)}, ${lit(customerId)}, ${lit(o.order_number)}, ${lit(o.status)}, ${lit(o.currency)}, ${lit(o.total_cents)},
  ${lit(o.items)}, ${lit(o.shipping_address ?? {})}, ${lit(o.carrier)}, ${lit(o.tracking_number)}, ${dateIn(o.estimated_delivery_in_days)},
  ${daysAgo(o.placed_days_ago)}, ${daysAgo(o.shipped_days_ago)}, ${daysAgo(o.delivered_days_ago)})
on conflict (id) do update set customer_id = excluded.customer_id, status = excluded.status, currency = excluded.currency,
  total_cents = excluded.total_cents, items = excluded.items, shipping_address = excluded.shipping_address,
  carrier = excluded.carrier, tracking_number = excluded.tracking_number, estimated_delivery = excluded.estimated_delivery,
  placed_at = excluded.placed_at, shipped_at = excluded.shipped_at, delivered_at = excluded.delivered_at;`),
    );
    const charges = o.duplicate_charge ? 2 : 1;
    const paymentIds: string[] = [];
    for (let i = 0; i < charges; i++) {
      const paymentId = stableUuid("payment", cfg.slug, o.order_number, String(i));
      paymentIds.push(paymentId);
      orderSql.push(
        keep(`insert into public.payments (id, tenant_id, order_id, customer_id, amount_cents, status, captured_at)
values (${lit(paymentId)}, ${lit(tenantId)}, ${lit(orderId)}, ${lit(customerId)}, ${lit(o.total_cents)}, 'captured', ${daysAgo(o.placed_days_ago)})
on conflict (id) do update set amount_cents = excluded.amount_cents, status = 'captured', captured_at = excluded.captured_at;`),
      );
    }
    if (cfg.demo)
      reset.push(
        `delete from public.payments where tenant_id = ${lit(tenantId)} and order_id = ${lit(orderId)} and id <> all(${uuidArray(paymentIds)});`,
      );
  }

  for (const doc of kbDocs) {
    const docId = stableUuid("kb", cfg.slug, doc.slug);
    const { title, chunks } = chunkMarkdown(doc.markdown);
    out.push(
      `insert into public.kb_documents (id, tenant_id, slug, title, content) values (${lit(docId)}, ${lit(tenantId)}, ${lit(doc.slug)}, ${lit(title)}, ${lit(doc.markdown)})
  on conflict (id) do update set title = excluded.title, content = excluded.content;`,
    );
    chunks.forEach((content, i) => {
      // Embeddings are filled by `npm run kb:embed`; unchanged chunks keep their existing embedding.
      out.push(
        `insert into public.kb_chunks (id, tenant_id, document_id, chunk_index, content) values (${lit(stableUuid("chunk", cfg.slug, doc.slug, String(i)))}, ${lit(tenantId)}, ${lit(docId)}, ${i}, ${lit(content)})
  on conflict (document_id, chunk_index) do update set content = excluded.content,
    embedding = case when public.kb_chunks.content = excluded.content then public.kb_chunks.embedding else null end;`,
      );
    });
    out.push(
      `delete from public.kb_chunks where document_id = ${lit(docId)} and chunk_index >= ${chunks.length};`,
    );
  }

  // The config is the source of truth: rows removed from it are removed from the database
  // (orders cascade to payments; KB documents cascade to chunks).
  const orderIds = cfg.orders.map((o) => stableUuid("order", cfg.slug, o.order_number));
  const docIds = kbDocs.map((d) => stableUuid("kb", cfg.slug, d.slug));
  if (cfg.demo)
    reset.push(
      `delete from public.orders where tenant_id = ${lit(tenantId)} and id <> all(${uuidArray(orderIds)});`,
    );
  if (cfg.demo)
    cleanup.push(
      `delete from public.customers where tenant_id = ${lit(tenantId)} and id <> all(${uuidArray([...customerIds.values()])});`,
    );
  out.push(
    `delete from public.kb_documents where tenant_id = ${lit(tenantId)} and id <> all(${uuidArray(docIds)});`,
  );

  // Real clients' orders, payments and refunds are live business records: the seed never resets
  // them. Demo resets are also guarded in SQL by tenants.is_demo, so a hand-edited seed can't
  // reach a real tenant either.
  const resetSql = cfg.demo
    ? `if exists (select 1 from public.tenants where id = ${lit(tenantId)} and is_demo) then\n${reset.join("\n\n")}\nend if;`
    : "";
  return { setup: out.join("\n\n"), reset: resetSql, cleanup: cleanup.join("\n\n") };
}
