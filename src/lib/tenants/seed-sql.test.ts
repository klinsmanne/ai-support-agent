import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../rag/chunk";
import { TenantConfigSchema } from "./config";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { buildTenantSeedSql, lit, stableUuid } from "./seed-sql";

describe("lit (SQL literal rendering)", () => {
  it("escapes single quotes so config text can't break out of the literal", () => {
    expect(lit("O'Brien'); drop table tenants; --")).toBe("'O''Brien''); drop table tenants; --'");
  });
  it("renders null, numbers, booleans and json", () => {
    expect(lit(undefined)).toBe("null");
    expect(lit(42)).toBe("42");
    expect(lit(false)).toBe("false");
    expect(lit({ a: "it's" })).toBe(`'{"a":"it''s"}'::jsonb`);
  });
  it("rejects non-finite numbers", () => {
    expect(() => lit(Number.NaN)).toThrow();
  });
});

describe("stableUuid", () => {
  it("is deterministic and a valid v5-style UUID", () => {
    const a = stableUuid("tenant", "harbor-pine");
    expect(a).toBe(stableUuid("tenant", "harbor-pine"));
    expect(a).not.toBe(stableUuid("tenant", "cadence-analytics"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("chunkMarkdown", () => {
  it("creates one titled chunk per section", () => {
    const { title, chunks } = chunkMarkdown(
      "# Returns\n\nIntro.\n\n## Sale items\nFinal sale.\n\n## Exchanges\nNo.",
    );
    expect(title).toBe("Returns");
    expect(chunks).toEqual([
      "Returns\nIntro.",
      "Returns — Sale items\nFinal sale.",
      "Returns — Exchanges\nNo.",
    ]);
  });
  it("handles a BOM, '#Title' without a space, and '##' inside code fences", () => {
    const { title, chunks } = chunkMarkdown(
      "﻿#Guide\n## A\n```\n## not a heading\n```\n## B\nText.",
    );
    expect(title).toBe("Guide");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("## not a heading");
  });

  it("splits a single oversized paragraph and keeps every chunk within the limit", () => {
    const sentence = "This sentence is about forty characters. ";
    const { chunks } = chunkMarkdown(`# T\n## S\n${sentence.repeat(60)}`, 300);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    const unbroken = chunkMarkdown(`# T\n${"x".repeat(1000)}`, 300).chunks;
    expect(unbroken.every((c) => c.length <= 300)).toBe(true);
  });

  it("splits long sections on paragraph boundaries", () => {
    const para = "x".repeat(700);
    const { chunks } = chunkMarkdown(`# T\n## S\n${para}\n\n${para}`, 1000);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.startsWith("T — S\n"))).toBe(true);
  });
});

describe("TenantConfigSchema", () => {
  const base = {
    slug: "acme",
    name: "Acme",
    industry: "ecommerce",
    settings: {
      refund_auto_approve_limit_cents: 1000,
      max_refunds_per_customer_30d: 1,
      escalate_on_negative_sentiment_below: -0.5,
      min_confidence_to_act: 0.7,
      enabled_tools: ["get_customer", "escalate_to_human"],
      brand_name: "Acme",
      brand_voice: "Friendly and short.",
      supported_languages: ["en"],
      allowed_link_domains: ["acme.example"],
      daily_ticket_cap: 10,
      max_ai_replies_per_thread: 3,
      retention_days: 30,
    },
    customers: [{ key: "a", email: "A@Example.com", name: "A" }],
    orders: [],
  };

  it("accepts a minimal valid tenant and lowercases emails", () => {
    const parsed = TenantConfigSchema.parse(base);
    expect(parsed.customers[0].email).toBe("a@example.com");
    expect(parsed.settings.rollout_mode).toBe("shadow"); // safest default
  });
  it("requires the escalate_to_human tool", () => {
    const bad = { ...base, settings: { ...base.settings, enabled_tools: ["get_customer"] } };
    expect(TenantConfigSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects unknown tools and unknown fields", () => {
    expect(
      TenantConfigSchema.safeParse({
        ...base,
        settings: { ...base.settings, enabled_tools: ["run_sql", "escalate_to_human"] },
      }).success,
    ).toBe(false);
    expect(TenantConfigSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });
  it("rejects orders that reference unknown customers", () => {
    const order = {
      order_number: "A100",
      customer: "ghost",
      status: "pending",
      total_cents: 100,
      items: [{ sku: "S", name: "N", qty: 1, price_cents: 100 }],
      placed_days_ago: 1,
    };
    expect(TenantConfigSchema.safeParse({ ...base, orders: [order] }).success).toBe(false);
  });
});

describe("buildTenantSeedSql: demo vs real tenants", () => {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "tenants", "harbor-pine", "tenant.json"), "utf8"),
  );
  it("a demo tenant gets a reset, guarded by is_demo in SQL", () => {
    const sql = buildTenantSeedSql(TenantConfigSchema.parse(raw), []);
    expect(sql.reset).toMatch(/and is_demo\) then/);
    expect(sql.reset).toContain("delete from public.refunds");
  });
  it("a real client never gets refunds, orders or customers deleted or overwritten", () => {
    const real = TenantConfigSchema.parse({ ...raw, demo: false });
    const sql = buildTenantSeedSql(real, []);
    const all = `${sql.setup}\n${sql.reset}\n${sql.cleanup}`;
    expect(sql.reset).toBe("");
    expect(all).not.toMatch(/delete from public\.(refunds|orders|payments|customers)/);
    expect(sql.setup).toMatch(/insert into public\.orders[\s\S]*on conflict \(id\) do nothing;/);
    expect(sql.setup).not.toMatch(/insert into public\.orders[^;]*do update/);
  });
  it("defaults to not-demo when the flag is missing", () => {
    const rest = { ...raw };
    delete rest.demo;
    expect(TenantConfigSchema.parse(rest).demo).toBe(false);
  });
});
