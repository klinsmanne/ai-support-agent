import { z } from "zod";

/**
 * Server-side environment variables, validated once at startup.
 * Secrets live only in env vars (.env.local locally, Vercel env in the cloud) and are never committed.
 * Optional keys let the app boot before every integration is configured.
 */
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Model provider selection: switch models with one env var.
  LLM_PROVIDER: z.enum(["gemini", "groq", "anthropic"]).default("gemini"),
  LLM_MODEL: z.string().optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
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
