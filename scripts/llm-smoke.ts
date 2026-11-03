/**
 * Live smoke test: sends one tool-calling round trip through every configured model.
 * Usage: npm run llm:smoke
 */
import "./load-env.ts";
import {
  buildChain,
  type ChatMessage,
  type LLMConfig,
  type ToolSpec,
} from "../src/lib/llm/index.ts";

const tool: ToolSpec = {
  name: "get_orders",
  description: "Look up an order by its order number.",
  parameters: {
    type: "object",
    properties: { order_number: { type: "string" } },
    required: ["order_number"],
    additionalProperties: false,
  },
};

const cfg = process.env as unknown as LLMConfig;
for (const provider of buildChain({ ...cfg, LLM_PROVIDER: cfg.LLM_PROVIDER ?? "gemini" })) {
  const label = `${provider.id}:${provider.model}`.padEnd(34);
  try {
    const messages: ChatMessage[] = [{ role: "user", content: "Where is my order 1042?" }];
    const first = await provider.generate({
      system: "You are a support agent. Use tools to look up orders before answering.",
      messages,
      tools: [tool],
      timeoutMs: 30_000,
    });
    const call = first.toolCalls[0];
    if (!call) {
      console.log(`${label} ⚠ no tool call (${first.latencyMs} ms): ${first.text.slice(0, 60)}`);
      continue;
    }
    messages.push({
      role: "assistant",
      content: first.text,
      toolCalls: first.toolCalls,
      replay: first.replay,
    });
    messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: JSON.stringify({
        order_number: "1042",
        status: "delayed",
        eta: "in 3 days",
        carrier: "Example Carrier",
      }),
    });
    const second = await provider.generate({
      system: "You are a support agent.",
      messages,
      tools: [tool],
      timeoutMs: 30_000,
    });
    console.log(
      `${label} ✓ ${call.name}(${JSON.stringify(call.arguments)}) → "${second.text.slice(0, 70).replace(/\n/g, " ")}…" (${first.latencyMs + second.latencyMs} ms, ${first.usage.inputTokens + second.usage.inputTokens} in / ${first.usage.outputTokens + second.usage.outputTokens} out tokens)`,
    );
  } catch (error) {
    console.log(`${label} ✗ ${(error as Error).message.slice(0, 100)}`);
  }
}
