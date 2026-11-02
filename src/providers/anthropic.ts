/**
 * Adapter Anthropic memakai @anthropic-ai/sdk resmi (docs/PROVIDERS.md bagian 5).
 * Bukan shim OpenAI-compatible.
 */

import Anthropic from "@anthropic-ai/sdk";
import { OmopError } from "../core/errors.js";
import type { ContentBlock, Message, ModelRequest, Usage } from "../core/types.js";
import {
  estimateCost,
  type ModelCapabilities,
  type ModelEvent,
  type ModelProvider,
} from "./types.js";

export interface AnthropicOptions {
  apiKey?: string;
  contextTokens?: number;
  inputPerMTok?: number;
  outputPerMTok?: number;
  /** Untuk tes. */
  client?: Anthropic;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly caps: ModelCapabilities;

  constructor(opts: AnthropicOptions = {}) {
    this.client =
      opts.client ??
      new Anthropic({
        apiKey: opts.apiKey,
        maxRetries: 0, // retry ditangani harness agar bisa pindah ke fallback
      });
    this.caps = {
      contextTokens: opts.contextTokens ?? 200000,
      inputPerMTok: opts.inputPerMTok,
      outputPerMTok: opts.outputPerMTok,
    };
  }

  capabilities(_model: string): ModelCapabilities {
    return this.caps;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const messages = toAnthropicMessages(request.messages);
    let stream;
    try {
      stream = await this.client.messages.stream(
        {
          model: request.model,
          system: request.system,
          max_tokens: request.maxTokens,
          messages,
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                })),
              }
            : {}),
        },
        { signal },
      );
    } catch (err) {
      if (signal.aborted) return;
      throw classify(err);
    }

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          yield { type: "text_delta", text: delta.text };
        }
      }
    }

    const final = await stream.finalMessage();
    const usage: Usage = {
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      costUsd: 0,
    };
    usage.costUsd = estimateCost(usage, this.caps);

    const content: ContentBlock[] = [];
    for (const block of final.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "" });

    const message: Message = {
      role: "assistant",
      content,
      providerRaw: { provider: "anthropic", payload: final },
    };

    let stopReason: ModelEvent extends never ? never : import("../core/types.js").StopReason;
    stopReason = mapStop(final.stop_reason);
    yield { type: "message", message, usage, stopReason };
  }
}

function mapStop(reason: string | null | undefined): import("../core/types.js").StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause_turn";
    default:
      return "other";
  }
}

function classify(err: unknown): OmopError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new OmopError("PROVIDER_AUTH", "Anthropic menolak API key (401/403).");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new OmopError("PROVIDER_RATE_LIMIT", "Anthropic rate limit (429).");
  }
  if (err instanceof Anthropic.APIError) {
    return new OmopError("PROVIDER_ERROR", `Anthropic error ${err.status}.`);
  }
  return new OmopError("PROVIDER_ERROR", `Anthropic error: ${String(err)}`);
}

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const b of m.content) {
      if (b.type === "text") blocks.push({ type: "text", text: b.text });
      if (b.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        });
      }
      if (b.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: b.toolUseId,
          content: b.content,
          is_error: b.isError,
        });
      }
    }
    if (blocks.length === 0) continue;
    out.push({ role: m.role, content: blocks });
  }
  return out;
}
