import { describe, expect, it } from "vitest";
import { parseInviteArgs } from "../../scripts/dashboard-users-args";

describe("dashboard:users arguments fail closed (security review)", () => {
  it("accepts the three intended forms", () => {
    expect(parseInviteArgs([])).toEqual({ email: undefined, tenant: undefined, role: "owner" });
    expect(parseInviteArgs(["Op@X.com", "--all-tenants"])).toEqual({
      email: "op@x.com",
      tenant: undefined,
      role: "owner",
    });
    expect(parseInviteArgs(["lead@c.com", "--tenant", "acme", "--role", "agent"])).toEqual({
      email: "lead@c.com",
      tenant: "acme",
      role: "agent",
    });
  });

  it("rejects every typo that used to widen access to all tenants", () => {
    for (const argv of [
      ["lead@c.com"], // no scope given
      ["lead@c.com", "--tenant=acme"],
      ["lead@c.com", "--tenant"],
      ["lead@c.com", "-tenant", "acme"],
      ["lead@c.com", "--Tenant", "acme"],
      ["lead@c.com", "--tenant", "acme", "--role"],
      ["lead@c.com", "--tenant", "acme", "--role", "viewer"],
      ["lead@c.com", "--role", "agent"],
      ["lead@c.com", "--tenant", "acme", "--all-tenants"],
      ["--tenant", "acme"],
      ["--all-tenants"],
    ])
      expect(() => parseInviteArgs(argv), argv.join(" ")).toThrow();
  });
});
