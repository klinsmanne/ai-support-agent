import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client. It bypasses RLS, so every query made with it MUST be scoped by
 * tenant_id explicitly (see repositories). Never import this into client components; the app
 * gets it through `src/lib/db/server.ts`, which is guarded by `server-only`.
 */
export function createServiceClient(url: string, secretKey: string): SupabaseClient {
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "support-agent" } },
  });
}
