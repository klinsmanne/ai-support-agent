import "server-only";
import { timingSafeEqual } from "node:crypto";
import { buildContainer, type Container } from "./build.ts";

export { DEFAULT_TENANT_SLUG, type Container } from "./build.ts";

let cached: Container | null = null;

/** One container per serverless instance; route handlers never read process.env directly. */
export function getContainer(): Container {
  cached ??= buildContainer(process.env);
  return cached;
}
/** Constant-time check of `Authorization: Bearer <CRON_SECRET>` for scheduled/internal calls. */
export function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
