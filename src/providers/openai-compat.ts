/**
 * Adapter OpenAI-compatible (docs/PROVIDERS.md bagian 4).
 * POST {base_url}/chat/completions dengan stream: true.
 */

import { OmopError } from "../core/errors.js";
import type { Message, ModelRequest, Usage } from "../core/types.js";
import {
  assembleToolCalls,
  estimateCost,
  mapOpenAIFinish,
  toOpenAIMessages,
  toOpenAITools,
  type ModelCapabilities,
  type ModelEvent,
  type ModelProvider,
  type OpenAIStreamChunk,
} from "./types.js";

export interface OpenAICompatOptions {
  name: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  contextTokens?: number;
  inputPerMTok?: number;
  outputPerMTok?: number;
  /** Untuk tes: inject fetch. */
  fetchImpl?: typeof fetch;
}

export class OpenAICompatProvider implements ModelProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private readonly caps: ModelCapabilities;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAICompatOptions) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.headers = opts.headers ?? {};
    this.caps = {
      contextTokens: opts.contextTokens ?? 128000,
      inputPerMTok: opts.inputPerMTok,
      outputPerMTok: opts.outputPerMTok,
    };
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  capabilities(_model: string): ModelCapabilities {
    return this.caps;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const body = {
      model: request.model,
      messages: toOpenAIMessages(request.system, request.messages),
      max_tokens: request.maxTokens,
      stream: true,
      ...(request.tools.length > 0 ? { tools: toOpenAITools(request.tools) } : {}),
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.headers,
    };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      throw new OmopError("PROVIDER_ERROR", `Gagal menghubungi ${this.name}: ${String(err)}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new OmopError("PROVIDER_AUTH", `${this.name} menolak API key (${response.status}).`);
    }
    if (response.status === 429) {
      throw new OmopError("PROVIDER_RATE_LIMIT", `${this.name} rate limit (429).`);
    }
    if (!response.ok || !response.body) {
      throw new OmopError("PROVIDER_ERROR", `${this.name} mengembalikan HTTP ${response.status}.`);
    }

    const toolDeltas: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] = [];
    let text = "";
    let finishReason: string | null = null;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIStreamChunk;
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          text += choice.delta.content;
          yield { type: "text_delta", text: choice.delta.content };
        }
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) toolDeltas.push(tc);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            costUsd: 0,
          };
        }
      }
    }

    usage.costUsd = estimateCost(usage, this.caps);
    const message = buildMessage(request.messages, text, toolDeltas);
    yield {
      type: "message",
      message,
      usage,
      stopReason: mapOpenAIFinish(finishReason),
    };
  }
}

function buildMessage(
  history: Message[],
  text: string,
  toolDeltas: { index: number; id?: string; function?: { name?: string; arguments?: string } }[],
): Message {
  const content: Message["content"] = [];
  if (text.length > 0) content.push({ type: "text", text });
  const calls = assembleToolCalls(toolDeltas);
  for (const c of calls) {
    let parsed: unknown = c.argsText;
    let invalid = c.argsText.length > 0;
    if (c.argsText.length > 0) {
      try {
        parsed = JSON.parse(c.argsText);
        invalid = false;
      } catch {
        invalid = true;
      }
    }
    if (invalid) {
      // Argumen JSON tidak valid ditandai, dikembalikan ke model sebagai error.
      content.push({
        type: "tool_result",
        toolUseId: c.id,
        content: "Argumen tool bukan JSON valid. Kirim ulang dengan JSON yang valid.",
        isError: true,
      });
      continue;
    }
    content.push({ type: "tool_use", id: c.id, name: c.name, input: parsed });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  void history;
  return { role: "assistant", content };
}
