import { errorKindFromStatus, fetchWithTimeout, LLMError } from "./types.ts";

export const EMBEDDING_MODEL = "gemini-embedding-2";
export const EMBEDDING_DIMENSIONS = 768; // matches kb_chunks.embedding vector(768)

type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/** Embeds texts with Gemini's free embedding model (batched, 768 dims, unit-normalized). */
export async function embedTexts(
  apiKey: string,
  texts: string[],
  taskType: TaskType,
  timeoutMs = 20_000,
): Promise<number[][]> {
  if (!texts.length) return [];
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
      }),
    },
    timeoutMs,
    { provider: "gemini", model: EMBEDDING_MODEL },
  );
  const json = (await res.json().catch(() => ({}))) as {
    embeddings?: { values: number[] }[];
    error?: { message?: string };
  };
  if (!res.ok || !json.embeddings) {
    throw new LLMError(
      errorKindFromStatus(res.status),
      String(json.error?.message ?? res.statusText).slice(0, 300),
      "gemini",
      EMBEDDING_MODEL,
      res.status,
    );
  }
  return json.embeddings.map((e) => normalize(e.values));
}

function normalize(v: number[]): number[] {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** pgvector literal, e.g. "[0.1,0.2,...]" */
export const toVectorLiteral = (v: number[]) => `[${v.join(",")}]`;
