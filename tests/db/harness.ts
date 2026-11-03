import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const root = join(import.meta.dirname, "..", "..");

/**
 * Minimal stand-in for the Supabase platform pieces our migrations depend on:
 * roles (anon/authenticated/service_role), auth.users, auth.uid(), and Supabase's
 * default table grants. Lets CI verify schema + RLS without Docker or a cloud project.
 */
const SUPABASE_SHIM = `
  create schema if not exists extensions;
  create schema if not exists auth;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, extensions, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant select on auth.users to service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export async function createTestDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { vector } });
  await db.exec(SUPABASE_SHIM);
  const migrationsDir = join(root, "supabase", "migrations");
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

export const seedSql = () => readFileSync(join(root, "supabase", "seed.sql"), "utf8");

/** Run a query as a dashboard user (role authenticated + JWT subject), like PostgREST does. */
export async function asUser<T>(
  db: PGlite,
  userId: string | null,
  sql: string,
  params: unknown[] = [],
) {
  return db.transaction(async (tx) => {
    await tx.exec(userId ? "set local role authenticated" : "set local role anon");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
    return tx.query<T>(sql, params);
  });
}
