import { describe, expect, it } from "vitest";
import { CASES, SAMPLE_IDS } from "./cases";

describe("eval sample", () => {
  it("is 15 real, unique cases covering every category", () => {
    expect(SAMPLE_IDS).toHaveLength(15);
    expect(new Set(SAMPLE_IDS).size).toBe(SAMPLE_IDS.length);
    const ids = new Set(CASES.map((c) => c.id));
    for (const id of SAMPLE_IDS) expect(ids.has(id), id).toBe(true);
    const cats = new Set(CASES.filter((c) => SAMPLE_IDS.includes(c.id)).map((c) => c.category));
    expect(cats).toEqual(new Set(CASES.map((c) => c.category)));
  });

  it("includes both tenants", () => {
    const tenants = new Set(CASES.filter((c) => SAMPLE_IDS.includes(c.id)).map((c) => c.tenant));
    expect(tenants.size).toBe(new Set(CASES.map((c) => c.tenant)).size);
  });
});
