/**
 * Provider-neutral LLM interface. The agent orchestrator only speaks these types,
 * so models can be swapped (Gemini, Groq, Claude) by configuration.
 */

/** JSON Schema object (generated from Zod via z.toJSONSchema). */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments as produced by the model — untrusted until schema-validated. */
  arguments: unknown;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      /**
       * Provider-native content of this turn, replayed verbatim to the same provider family.
       * Gemini 3 thought signatures and Claude thinking blocks must be sent back unchanged.
       */
      replay?: { provider: ProviderId; model: string; content: unknown };
    }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export type ProviderId = "gemini" | "groq" | "anthropic" | "mock";

export interface GenerateRequest {
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** When set, the model must return JSON matching this schema (structured output). */
  responseSchema?: JsonSchema;
  maxOutputTokens?: number;
  /** Max duration of a single provider call. */
  timeoutMs: number;
  /**
   * Absolute deadline (epoch ms) for the whole routed request, across every fallback attempt
   * and rate-limit wait. Lets the agent enforce one end-to-end time budget.
   */
  deadline?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateResult {
  provider: ProviderId;
  model: string;
  text: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "refusal" | "other";
  usage: Usage;
  latencyMs: number;
  replay?: { provider: ProviderId; model: string; content: unknown };
}

export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export type LLMErrorKind =
  "rate_limit" | "unavailable" | "timeout" | "bad_request" | "auth" | "unknown";

/** Normalized provider error. `retryable` errors trigger fallback to the next model in the chain. */
export class LLMError extends Error {
  constructor(
    readonly kind: LLMErrorKind,
    message: string,
    readonly provider: ProviderId,
    readonly model: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "unavailable" || this.kind === "timeout";
  }
}

export function errorKindFromStatus(status: number): LLMErrorKind {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "bad_request";
  return "unknown";
}

/** fetch with a hard timeout that surfaces as LLMError("timeout"). */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  who: { provider: ProviderId; model: string },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new LLMError("timeout", `timed out after ${timeoutMs} ms`, who.provider, who.model);
    }
    throw new LLMError(
      "unavailable",
      `network error: ${(error as Error).message}`,
      who.provider,
      who.model,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Parses tool-call argument JSON; invalid JSON becomes a marker the validator will reject. */
export function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid_json__: raw.slice(0, 200) };
  }
}
