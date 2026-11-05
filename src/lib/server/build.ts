import type { SupabaseClient } from "@supabase/supabase-js";
import { GmailClient } from "../channels/email/gmail-client.ts";
import { createServiceClient } from "../db/client.ts";
import { SupabaseRepo } from "../db/supabase-repo.ts";
import { parseServerEnv, type ServerEnv } from "../env.ts";
import { embedTexts } from "../llm/embeddings.ts";
import { buildChain, createClassifierRouter, createRouter } from "../llm/index.ts";
import type { PipelineDeps } from "../pipeline/ingest.ts";
import { SupabaseStore } from "../pipeline/supabase-store.ts";
import { SupabaseChatStore, type ChatStore } from "../channels/chat/store.ts";
import { fanOut, ntfySender } from "../pipeline/alert-channels.ts";
import type { AlertSend } from "../pipeline/alerts.ts";

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

  const llmEmail = { noTraining: true };
  if (!buildChain(env, llmEmail).length) {
    // Email still fails closed (tickets go to needs_attention), but say why at startup.
    console.error(
      "No no-training LLM provider configured (GROQ_API_KEY): email can't be answered by AI.",
    );
  }
  if (env.GEMINI_PAID_TIER === "true") {
    console.warn(
      "GEMINI_PAID_TIER=true: Gemini is used for email. Only set this on a billing-enabled project.",
    );
  }

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
      email: {
        router: createRouter(env, llmEmail),
        classifierRouter: createClassifierRouter(env, llmEmail),
        // Keyword-only retrieval: the free embedding API is a training-allowed Google service.
        repo: env.GEMINI_PAID_TIER === "true" ? repo : new SupabaseRepo(db, null),
      },
      sender: gmail,
      // Two independent channels (ADR-026): email, plus ntfy push so a Gmail outage still alerts.
      alert: (() => {
        const channels: AlertSend[] = [];
        if (gmail && env.ALERT_EMAIL)
          channels.push(async (subject, body) => {
            await gmail.sendNew(env.ALERT_EMAIL!, subject, body);
          });
        if (env.ALERT_NTFY_TOPIC) channels.push(ntfySender(env.ALERT_NTFY_TOPIC));
        return channels.length ? fanOut(channels) : null;
      })(),
      inboxAddress: inbox,
      defaultTenantSlug: DEFAULT_TENANT_SLUG,
      csatUrl: appUrl ? (ticketId: string) => `${appUrl}/csat/${ticketId}` : undefined,
      notifyTeam: gmail ? (to, subject, body) => gmail.sendNew(to, subject, body) : null,
      ticketUrl: appUrl
        ? (ticketId: string) => `${appUrl}/dashboard/tickets/${ticketId}`
        : undefined,
    },
    defaultTenantId: async () => {
      const id = await store.tenantIdBySlug(DEFAULT_TENANT_SLUG);
      if (!id) throw new Error("default tenant missing");
      return id;
    },
  };
}
