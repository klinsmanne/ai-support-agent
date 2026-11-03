/**
 * Fills missing KB chunk embeddings (new or changed chunks after `supabase db push --include-seed`).
 * Idempotent: only chunks with a NULL embedding are processed.  Usage: npm run kb:embed
 */
import "./load-env.ts";
import { createServiceClient } from "../src/lib/db/client.ts";
import { embedTexts, toVectorLiteral } from "../src/lib/llm/embeddings.ts";

const {
  NEXT_PUBLIC_SUPABASE_URL: url,
  SUPABASE_SECRET_KEY: key,
  GEMINI_API_KEY: gemini,
} = process.env;
if (!url || !key || !gemini) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY or GEMINI_API_KEY (run: npm run secrets sync)",
  );
  process.exit(1);
}
const db = createServiceClient(url, key);

const { data: chunks, error } = await db
  .from("kb_chunks")
  .select("id, content")
  .is("embedding", null)
  .limit(500);
if (error) throw new Error(error.message);
console.log(`${chunks.length} chunks need embeddings`);

const BATCH = 50;
for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  const vectors = await embedTexts(
    gemini,
    batch.map((c) => c.content),
    "RETRIEVAL_DOCUMENT",
  );
  for (const [j, chunk] of batch.entries()) {
    const { error: updateError } = await db
      .from("kb_chunks")
      .update({ embedding: toVectorLiteral(vectors[j]) })
      .eq("id", chunk.id);
    if (updateError) throw new Error(updateError.message);
  }
  console.log(`✓ embedded ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
}
