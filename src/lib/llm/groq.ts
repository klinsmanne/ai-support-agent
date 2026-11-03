import {
  errorKindFromStatus,
  fetchWithTimeout,
  LLMError,
  parseArguments,
  type ChatMessage,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
} from "./types.ts";

const URL = "https://api.groq.com/openai/v1/chat/completions";

/** Groq adapter (OpenAI-compatible chat completions) — free-tier fallback provider. */
export class GroqProvider implements LLMProvider {
  readonly id = "groq" as const;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "system", content: req.system }, ...toOpenAIMessages(req.messages)],
      max_completion_tokens: req.maxOutputTokens ?? 2048,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }
    if (req.responseSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "response", schema: req.responseSchema },
      };
    }

    const res = await fetchWithTimeout(
      URL,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      },
      req.timeoutMs,
      { provider: this.id, model: this.model },
    );
    const json = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- external API payload, narrowed below
    if (!res.ok) {
      const message = String(json?.error?.message ?? res.statusText).slice(0, 300);
      throw new LLMError(errorKindFromStatus(res.status), message, this.id, this.model, res.status);
    }

    const choice = json.choices?.[0];
    const msg = choice?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map(
      (c: { id: string; function: { name: string; arguments: string } }) => ({
        id: c.id,
        name: c.function.name,
        arguments: parseArguments(c.function.arguments),
      }),
    );
    const reason: string = choice?.finish_reason ?? "";

    return {
      provider: this.id,
      model: this.model,
      text: String(msg.content ?? "").trim(),
      toolCalls,
      finishReason: toolCalls.length
        ? "tool_calls"
        : reason === "stop"
          ? "stop"
          : reason === "length"
            ? "length"
            : reason === "content_filter"
              ? "refusal"
              : "other",
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
    };
  }
}

function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
              })),
            }
          : {}),
      };
    }
    return {
      role: "tool",
      tool_call_id: m.toolCallId,
      content: m.isError ? `ERROR: ${m.content}` : m.content,
    };
  });
}
