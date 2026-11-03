import Anthropic from "@anthropic-ai/sdk";
import {
  LLMError,
  type ChatMessage,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type ToolCall,
} from "./types.ts";

/**
 * Claude adapter (official Anthropic SDK). Inactive unless ANTHROPIC_API_KEY is set.
 * Notes for current models: no `temperature`, no forced tool_choice (auto only),
 * thinking is adaptive and controlled via `output_config.effort`, and assistant content
 * (including thinking blocks) is replayed unchanged between tool-use turns.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    // The router owns retries/fallback, so the SDK's own retries are disabled.
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    try {
      const response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: req.maxOutputTokens ?? 4096,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          // Server-side fallback re-runs a policy-declined request on a recommended model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: {
            effort: "low", // support triage: latency matters more than deep reasoning
            ...(req.responseSchema
              ? { format: { type: "json_schema", schema: req.responseSchema } }
              : {}),
          },
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
                })),
                tool_choice: { type: "auto" as const },
              }
            : {}),
        },
        { timeout: req.timeoutMs },
      );

      const toolCalls: ToolCall[] = [];
      let text = "";
      for (const block of response.content) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use")
          toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
      }

      const finishReason: GenerateResult["finishReason"] =
        response.stop_reason === "refusal"
          ? "refusal"
          : toolCalls.length
            ? "tool_calls"
            : response.stop_reason === "max_tokens"
              ? "length"
              : response.stop_reason === "end_turn"
                ? "stop"
                : "other";

      return {
        provider: this.id,
        model: response.model,
        text: text.trim(),
        toolCalls,
        finishReason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        latencyMs: Date.now() - started,
        replay: { provider: this.id, content: response.content },
      };
    } catch (error) {
      throw toLLMError(error, this.model);
    }
  }
}

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const content =
        m.replay?.provider === "anthropic"
          ? (m.replay.content as Anthropic.Beta.BetaContentBlockParam[])
          : [
              ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
              ...m.toolCalls.map((c) => ({
                type: "tool_use" as const,
                id: c.id,
                name: c.name,
                input: (c.arguments ?? {}) as Record<string, unknown>,
              })),
            ];
      out.push({ role: "assistant", content });
    } else {
      const block: Anthropic.Beta.BetaToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
        is_error: m.isError ?? false,
      };
      // All results for one assistant turn go back in a single user message.
      const last = out[out.length - 1];
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === "tool_result")
      ) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

function toLLMError(error: unknown, model: string): LLMError {
  const make = (kind: LLMError["kind"], status?: number) =>
    new LLMError(
      kind,
      (error as Error).message?.slice(0, 300) ?? "anthropic error",
      "anthropic",
      model,
      status,
    );
  if (error instanceof Anthropic.RateLimitError) return make("rate_limit", 429);
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return make("auth", error.status);
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) return make("timeout");
  if (error instanceof Anthropic.APIConnectionError) return make("unavailable");
  if (error instanceof Anthropic.InternalServerError) return make("unavailable", error.status);
  if (error instanceof Anthropic.BadRequestError) return make("bad_request", 400);
  if (error instanceof Anthropic.APIError) {
    return make((error.status ?? 0) >= 500 ? "unavailable" : "unknown", error.status);
  }
  return make("unknown");
}
