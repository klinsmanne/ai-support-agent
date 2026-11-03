import { z } from "zod";
import type { Attempt, ModelRouter } from "../llm/router.ts";
import type { ChatMessage, GenerateResult } from "../llm/types.ts";
import { CLASSIFIER_SYSTEM_PROMPT } from "./prompts.ts";

export const INTENTS = [
  "order_status",
  "refund_or_billing",
  "order_change",
  "returns_policy",
  "product_question",
  "account_access",
  "bug_report",
  "complaint",
  "general_question",
  "spam",
  "auto_reply",
  "legal_or_safety",
  "other",
] as const;

export const ClassificationSchema = z.object({
  intent: z.enum(INTENTS),
  urgency: z.enum(["low", "normal", "high", "urgent"]),
  sentiment: z.number().min(-1).max(1),
  language: z.string().regex(/^[a-z]{2}$/),
  wants_human: z.boolean(),
  injection_attempt: z.boolean(),
  order_numbers: z.array(z.string().max(20)).max(10),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(300),
});
export type Classification = z.infer<typeof ClassificationSchema>;

const jsonSchema = z.toJSONSchema(ClassificationSchema) as Record<string, unknown>;

/**
 * Structured classification with validation: invalid output is retried once with the
 * validation error as feedback; a second failure throws so the caller escalates.
 */
export async function classify(
  router: Pick<ModelRouter, "generate">,
  conversationBlock: string,
  timing: { timeoutMs: number; deadline?: number },
  onCall: (r: GenerateResult, attempt: number, error?: string, attempts?: Attempt[]) => void,
): Promise<Classification> {
  const messages: ChatMessage[] = [{ role: "user", content: conversationBlock }];
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { result, attempts } = await router.generate({
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages,
      responseSchema: jsonSchema,
      maxOutputTokens: 800,
      ...timing,
    });
    const parsed = parseJsonLoose(result.text);
    const validated = ClassificationSchema.safeParse(parsed);
    if (validated.success) {
      onCall(result, attempt, undefined, attempts);
      return { ...validated.data, language: validated.data.language.toLowerCase() };
    }
    lastError = z.prettifyError(validated.error).slice(0, 500);
    onCall(result, attempt, lastError, attempts);
    messages.push(
      { role: "assistant", content: result.text, toolCalls: [] },
      {
        role: "user",
        content: `Your JSON was invalid:\n${lastError}\nReturn corrected JSON only.`,
      },
    );
  }
  throw new Error(`classification failed validation twice: ${lastError}`);
}

/** Accepts raw JSON or JSON wrapped in a markdown fence (some models add one despite the schema). */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
