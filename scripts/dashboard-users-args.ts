/**
 * Argument parsing for `npm run dashboard:users`, kept separate so it can be unit-tested.
 * Strict and fail-closed (security review): a typo such as "--tenant=acme" must never silently
 * widen someone's access to every tenant.
 */
export interface InviteArgs {
  email?: string;
  /** Scope to one client. Undefined only for the operator (--all-tenants) or no invite at all. */
  tenant?: string;
  role: "owner" | "agent";
}

export function parseInviteArgs(argv: string[]): InviteArgs {
  let email: string | undefined;
  let tenant: string | undefined;
  let role: string | undefined;
  let allTenants = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all-tenants") allTenants = true;
    else if (a === "--tenant" || a === "--role") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) throw new Error(`${a} needs a value`);
      if (a === "--tenant") tenant = v;
      else role = v;
    } else if (!a.startsWith("-") && a.includes("@") && !email) email = a.toLowerCase();
    else
      throw new Error(
        `unknown argument "${a}" (use: <email> --tenant <slug> --role owner|agent, or <email> --all-tenants)`,
      );
  }
  if (role !== undefined && role !== "owner" && role !== "agent")
    throw new Error("--role must be owner or agent (viewer is reserved for the public demo)");
  if (role && !tenant) throw new Error("--role needs --tenant (operators are owners everywhere)");
  if (tenant && allTenants) throw new Error("use either --tenant or --all-tenants, not both");
  if ((tenant || allTenants) && !email)
    throw new Error("--tenant / --all-tenants need the email of the person to invite");
  if (email && !tenant && !allTenants)
    throw new Error("choose --tenant <slug> (a client's team) or --all-tenants (the operator)");
  return { email, tenant, role: (role ?? "owner") as "owner" | "agent" };
}
