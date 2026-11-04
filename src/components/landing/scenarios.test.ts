import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./scenarios";

type Tenant = {
  customers: { key: string; email: string }[];
  orders: { order_number: string; customer: string }[];
};
const load = (slug: string): Tenant =>
  JSON.parse(readFileSync(join(process.cwd(), "tenants", slug, "tenant.json"), "utf8"));
const SLUG = { "Harbor & Pine": "harbor-pine", "Cadence Analytics": "cadence-analytics" } as const;

describe("landing page scenarios", () => {
  it.each(SCENARIOS.filter((s) => s.verify))(
    "$verify.order belongs to $verify.email in the seed data",
    (s) => {
      const t = load(SLUG[s.tenant]);
      const order = t.orders.find((o) => o.order_number === s.verify!.order);
      expect(order, "order exists").toBeDefined();
      const owner = t.customers.find((c) => c.email === s.verify!.email);
      expect(owner, "customer exists").toBeDefined();
      expect(order!.customer, "order belongs to that customer").toBe(owner!.key);
    },
  );
});
