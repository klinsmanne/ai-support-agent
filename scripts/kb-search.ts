/**
 * Live retrieval check against Supabase (pgvector + full-text, tenant-scoped).
 * Usage: npm run kb:search -- "<query>" [tenant-slug]
 */
import "./load-env.ts";
import { createServiceClient } from "../src/lib/db/client.ts";
import { SupabaseRepo } from "../src/lib/db/supabase-repo.ts";
import { embedTexts } from "../src/lib/llm/embeddings.ts";
import { stableUuid } from "../src/lib/tenants/seed-sql.ts";

const [query = "can I return sale items", slug = "harbor-pine"] = process.argv.slice(2);
const env = process.env as Record<string, string>;
const repo = new SupabaseRepo(
  createServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY),
  async (text) => (await embedTexts(env.GEMINI_API_KEY, [text], "RETRIEVAL_QUERY"))[0],
);
const t0 = Date.now();
const hits = await repo.searchKb(stableUuid("tenant", slug), query, 4);
console.log(`"${query}" @ ${slug} — ${Date.now() - t0} ms`);
for (const h of hits) {
  console.log(
    `  ${h.score.toFixed(4)}  sim=${h.similarity?.toFixed(3) ?? "  —  "}  ${h.slug}: ${h.content.split("\n")[0]}`,
  );
}
