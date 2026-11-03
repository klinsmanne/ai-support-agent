import {
  errorKindFromStatus,
  fetchWithTimeout,
  LLMError,
  type ChatMessage,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type ToolCall,
} from "./types.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: unknown };
  functionResponse?: { id?: string; name: string; response: unknown };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** Gemini API (Google AI Studio) adapter over REST — free tier, function calling, JSON schema output. */
export class GeminiProvider implements LLMProvider {
  readonly id = "gemini" as const;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens ?? 2048,
        // Support replies need speed more than deep reasoning; the eval suite validates quality.
        thinkingConfig: { thinkingLevel: "low" },
        ...(req.responseSchema
          ? { responseMimeType: "application/json", responseJsonSchema: req.responseSchema }
          : {}),
      },
    };
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.parameters,
          })),
        },
      ];
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }

    const res = await fetchWithTimeout(
      `${BASE}/${this.model}:generateContent`,
      {
        method: "POST",
        // Key goes in a header, never the URL, so it can't leak into logs.
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
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

    const candidate = json.candidates?.[0];
    const parts: GeminiPart[] = candidate?.content?.parts ?? [];
    const text = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("")
      .trim();
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: p.functionCall!.id ?? `gemini-call-${Date.now()}-${i}`,
        name: p.functionCall!.name,
        arguments: p.functionCall!.args ?? {},
      }));

    const reason: string = candidate?.finishReason ?? "OTHER";
    const finishReason: GenerateResult["finishReason"] = toolCalls.length
      ? "tool_calls"
      : reason === "STOP"
        ? "stop"
        : reason === "MAX_TOKENS"
          ? "length"
          : ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(reason)
            ? "refusal"
            : "other";

    return {
      provider: this.id,
      model: this.model,
      text,
      toolCalls,
      finishReason,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
        outputTokens:
          (json.usageMetadata?.candidatesTokenCount ?? 0) +
          (json.usageMetadata?.thoughtsTokenCount ?? 0),
      },
      latencyMs: Date.now() - started,
      replay: { provider: this.id, content: parts },
    };
  }
}

function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      // Replay native parts so thought signatures on function calls survive (required by Gemini 3).
      const parts =
        m.replay?.provider === "gemini"
          ? (m.replay.content as GeminiPart[])
          : [
              ...(m.content ? [{ text: m.content }] : []),
              ...m.toolCalls.map((c) => ({
                functionCall: { id: c.id, name: c.name, args: c.arguments },
              })),
            ];
      contents.push({ role: "model", parts });
    } else {
      const part: GeminiPart = {
        functionResponse: {
          id: m.toolCallId.startsWith("gemini-call-") ? undefined : m.toolCallId,
          name: m.name,
          response: m.isError ? { error: m.content } : { result: m.content },
        },
      };
      // Consecutive tool results belong in one user turn.
      const last = contents[contents.length - 1];
      if (last?.role === "user" && last.parts.every((p) => p.functionResponse))
        last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }
  return contents;
}
