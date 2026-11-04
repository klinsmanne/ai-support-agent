import type { SupabaseClient } from "@supabase/supabase-js";
import { GmailClient } from "../channels/email/gmail-client.ts";
import { createServiceClient } from "../db/client.ts";
import { SupabaseRepo } from "../db/supabase-repo.ts";
import { parseServerEnv, type ServerEnv } from "../env.ts";
import { embedTexts } from "../llm/embeddings.ts";
import { createClassifierRouter, createRouter } from "../llm/index.ts";
import type { PipelineDeps } from "../pipeline/ingest.ts";
import { SupabaseStore } from "../pipeline/supabase-store.ts";
import { SupabaseChatStore, type ChatStore } from "../channels/chat/store.ts";

/**
 * Composition root: builds every server dependency from validated env vars. The app uses the
 * cached, server-only `getContainer()`; scripts call `buildContainer()` with their own env.
 */
export interface Container {
  env: ServerEnv;
  deps: PipelineDeps;
  store: SupabaseStore;
  chat: ChatStore;
  /** Service-role client (bypasses RLS): only for server actions that already checked roles. */
  db: SupabaseClient;
  gmail: GmailClient | null;
  defaultTenantId: () => Promise<string>;
}

export const DEFAULT_TENANT_SLUG = "harbor-pine";

/** Builds all server dependencies from an env source (process.env in the app; scripts pass theirs). */
export function buildContainer(source: Record<string, string | undefined>): Container {
  const env = parseServerEnv(source);
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SECRET_KEY)
    throw new Error("Supabase is not configured");
  const db = createServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  const gemini = env.GEMINI_API_KEY;
  const repo = new SupabaseRepo(
    db,
    gemini ? async (q) => (await embedTexts(gemini, [q], "RETRIEVAL_QUERY"))[0] : null,
  );
  const store = new SupabaseStore(db);
  const inbox = env.SUPPORT_EMAIL_ADDRESS ?? "support@example.com";
  const gmail =
    env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN
      ? new GmailClient({
          clientId: env.GMAIL_CLIENT_ID,
          clientSecret: env.GMAIL_CLIENT_SECRET,
          refreshToken: env.GMAIL_REFRESH_TOKEN,
          address: inbox,
          displayName: "Customer Support (AI-assisted)",
        })
      : null;
  const appUrl =
    source.APP_URL ??
    (source.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${source.VERCEL_PROJECT_PRODUCTION_URL}`
      : null);

  return {
    env,
    store,
    db,
    chat: new SupabaseChatStore(db),
    gmail,
    deps: {
      store,
      repo,
      router: createRouter(env),
      classifierRouter: createClassifierRouter(env),
      sender: gmail,
      inboxAddress: inbox,
      defaultTenantSlug: DEFAULT_TENANT_SLUG,
      csatUrl: appUrl ? (ticketId: string) => `${appUrl}/csat/${ticketId}` : undefined,
    },
    defaultTenantId: async () => {
      const id = await store.tenantIdBySlug(DEFAULT_TENANT_SLUG);
      if (!id) throw new Error("default tenant missing");
      return id;
    },
  };
}
