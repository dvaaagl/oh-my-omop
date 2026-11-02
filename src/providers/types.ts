/**
 * Provider model. Agent loop hanya mengenal interface ini.
 * Format netral mengikuti docs/PROVIDERS.md.
 */

import type {
  Message,
  ModelRequest,
  StopReason,
  ToolDefinition,
  Usage,
} from "../core/types.js";

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "message"; message: Message; usage: Usage; stopReason: StopReason };

export interface ModelCapabilities {
  contextTokens: number;
  inputPerMTok?: number;
  outputPerMTok?: number;
}

export interface ModelProvider {
  readonly name: string;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  capabilities(model: string): ModelCapabilities;
}

/** Bentuk streaming OpenAI chat/completions yang dipakai bersama. */
export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAIStreamChunk {
  choices?: {
    index: number;
    delta?: {
      content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
}

export function mapOpenAIFinish(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

/** Gabungkan potongan argumen tool per index. */
export function assembleToolCalls(
  deltas: OpenAIToolCallDelta[],
): { id: string; name: string; argsText: string }[] {
  const byIndex = new Map<number, { id: string; name: string; argsText: string }>();
  for (const d of deltas) {
    const cur =
      byIndex.get(d.index) ?? { id: d.id ?? "", name: "", argsText: "" };
    if (d.id) cur.id = d.id;
    if (d.function?.name) cur.name += d.function.name;
    if (d.function?.arguments) cur.argsText += d.function.arguments;
    byIndex.set(d.index, cur);
  }
  return [...byIndex.values()];
}

/** Ubah Message netral -> pesan OpenAI. */
export function toOpenAIMessages(
  system: string,
  messages: Message[],
): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      const parts: { type: string; text?: string }[] = [];
      const toolResults: { id: string; content: string }[] = [];
      for (const b of m.content) {
        if (b.type === "text") parts.push({ type: "text", text: b.text });
        if (b.type === "tool_result") toolResults.push({ id: b.toolUseId, content: b.content });
      }
      for (const tr of toolResults) {
        out.push({ role: "tool", tool_call_id: tr.id, content: tr.content });
      }
      if (parts.length > 0) {
        out.push({ role: "user", content: parts.map((p) => p.text ?? "").join("\n") });
      }
      continue;
    }
    // assistant
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const toolCalls = m.content
      .filter((b) => b.type === "tool_use")
      .map((b) => {
        if (b.type !== "tool_use") throw new Error("unreachable");
        return {
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        };
      });
    out.push({
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return out;
}

export function toOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

export function estimateCost(
  usage: Usage,
  caps: ModelCapabilities,
): number {
  if (caps.inputPerMTok === undefined || caps.outputPerMTok === undefined) return 0;
  return (
    (usage.inputTokens / 1_000_000) * caps.inputPerMTok +
    (usage.outputTokens / 1_000_000) * caps.outputPerMTok
  );
}
