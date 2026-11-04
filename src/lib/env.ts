import "server-only";
import { z } from "zod";

// Blank values (e.g. `GEMINI_API_KEY=` copied from .env.example) mean "not set", not "invalid".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/**
 * Server-side environment variables, validated before use.
 * Secrets live only in env vars (.env.local locally, Vercel env in the cloud) and are never committed.
 * Optional keys let the app boot before every integration is configured.
 */
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Model provider selection: switch models with one env var.
  LLM_PROVIDER: z.enum(["gemini", "groq", "anthropic"]).default("gemini"),
  LLM_MODEL: optional(z.string()),
  LLM_CHAIN: optional(z.string()),
  GEMINI_API_KEY: optional(z.string().min(1)),
  GROQ_API_KEY: optional(z.string().min(1)),
  ANTHROPIC_API_KEY: optional(z.string().min(1)),
  // Supabase (new-style keys: publishable is browser-safe; secret bypasses RLS — server only)
  NEXT_PUBLIC_SUPABASE_URL: optional(z.url()),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optional(z.string().min(1)),
  SUPABASE_SECRET_KEY: optional(z.string().min(1)),
  // Signs scheduled/cron calls and CSRF tokens
  CRON_SECRET: optional(z.string().min(32)),
  CSRF_SECRET: optional(z.string().min(32)),
  // Dashboard: public read-only demo account and the site's canonical URL
  DEMO_VIEWER_EMAIL: optional(z.email()),
  APP_URL: optional(z.url()),
  // Gmail channel
  GMAIL_CLIENT_ID: optional(z.string().min(1)),
  GMAIL_CLIENT_SECRET: optional(z.string().min(1)),
  GMAIL_REFRESH_TOKEN: optional(z.string().min(1)),
  SUPPORT_EMAIL_ADDRESS: optional(z.email()),
  ALERT_EMAIL: optional(z.email()),
  // Bot protection for the chat widget
  TURNSTILE_SITE_KEY: optional(z.string().min(1)),
  TURNSTILE_SECRET_KEY: optional(z.string().min(1)),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    // Report which variables are invalid without echoing their values.
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid environment variables: ${fields}`);
  }
  return result.data;
}
