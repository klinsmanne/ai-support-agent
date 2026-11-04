import {
  classify429,
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
  readonly trainsOnInputs = false; // GroqCloud Services Agreement §4.2

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

    // gpt-oss on Groq occasionally emits a call to a tool that wasn't offered (e.g. "json"), which
    // Groq rejects as `tool_use_failed`. Sampling differs per request, so one retry usually
    // succeeds (found by the eval suite); anything else is reported to the router as usual.
    let res: Response;
    let json: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- external API payload, narrowed below
    for (let attempt = 1; ; attempt++) {
      res = await fetchWithTimeout(
        URL,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
        },
        req.timeoutMs,
        { provider: this.id, model: this.model },
      );
      json = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- see above
      if (res.ok) break;
      const message = String(json?.error?.message ?? res.statusText).slice(0, 300);
      if (attempt < 3 && res.status === 400 && isToolUseFailed(json, message)) continue;
      const kind = res.status === 429 ? classify429(message) : errorKindFromStatus(res.status);
      throw new LLMError(kind, message, this.id, this.model, res.status);
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

function isToolUseFailed(
  json: { error?: { code?: string } } | undefined,
  message: string,
): boolean {
  // tool_use_failed: called a tool that wasn't offered; output_parse_failed: malformed generation.
  return (
    json?.error?.code === "tool_use_failed" ||
    json?.error?.code === "output_parse_failed" ||
    /tool call validation failed|parsing failed/i.test(message)
  );
}

function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "assistant") {
      return {
        role: "assistant",
        // Groq rejects null content on an assistant turn without tool calls.
        content: m.content || (m.toolCalls.length ? null : ""),
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
