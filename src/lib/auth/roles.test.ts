import { describe, expect, it } from "vitest";
import { requireRole, type Viewer } from "./server";

const viewer = (role: "owner" | "agent" | "viewer"): Viewer => ({
  userId: "u",
  email: "x@example.com",
  isDemo: role === "viewer",
  memberships: [{ tenantId: "t1", slug: "a", name: "A", role }],
});

describe("requireRole (every dashboard write action calls this)", () => {
  it("lets owners and agents act on their own tenant", () => {
    expect(requireRole(viewer("owner"), "t1", ["owner"]).role).toBe("owner");
    expect(requireRole(viewer("agent"), "t1", ["owner", "agent"]).role).toBe("agent");
  });
  it.each([
    ["the demo viewer approving a reply", viewer("viewer"), "t1", ["owner", "agent"]],
    ["an agent changing settings", viewer("agent"), "t1", ["owner"]],
    ["an owner acting on another tenant", viewer("owner"), "t2", ["owner"]],
    ["a signed-out request", null, "t1", ["owner"]],
  ] as const)("refuses %s", (_label, v, tenant, roles) => {
    expect(() => requireRole(v, tenant, [...roles])).toThrow("forbidden");
  });
});
