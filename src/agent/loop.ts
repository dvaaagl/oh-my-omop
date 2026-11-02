/**
 * Agent loop (docs/AGENT.md bagian 1, 2).
 *
 * Algoritma satu giliran:
 *   1. Simpan pesan pengguna dan event.
 *   2. Bangun system prompt dari snapshot sesi.
 *   3. Ulangi sampai selesai:
 *      a. Cek batas iterasi, waktu, biaya giliran, dan biaya harian.
 *      b. Siapkan pesan lewat ContextEngine.
 *      c. Panggil provider dengan retry dan model cadangan. Stream teks ke kanal.
 *      d. Simpan pesan asisten, token, dan biaya.
 *      e. Periksa stop reason.
 *      f. Validasi dan jalankan semua tool call lewat policy.
 *      g. Kirim semua hasil tool dalam SATU pesan pengguna.
 *   4. Simpan ringkasan giliran dan jadwalkan background review.
 */

import type {
  AgentEvent,
  ContentBlock,
  Message,
  ToolCall,
  ToolContext,
  TurnSummary,
  Usage,
} from "../core/types.js";
import { OmopError } from "../core/errors.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { ToolRegistry, Tool } from "../tools/registry.js";
import { validateInput } from "../tools/registry.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ModelProvider } from "../providers/types.js";
import type { ContextEngine } from "./context-engine.js";
import type { SessionStore } from "./session.js";
import type { OmopConfig } from "../core/config.js";

export interface AgentLoopOptions {
  config: OmopConfig;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  policy: PolicyEngine;
  contextEngine: ContextEngine;
  sessions: SessionStore;
  /** Bangun system prompt untuk sesi ini. */
  buildSystemPrompt: (sessionId: string) => Promise<{ system: string; stableHash: string }>;
  /** Handler approval dari kanal. */
  onApproval: (
    toolName: string,
    displayText: string,
    effectiveRisk: "medium" | "high",
    tainted: boolean,
    allowAlways: boolean,
  ) => Promise<"allow_once" | "allow_always" | "deny">;
  /** Callback tiap event. */
  emit: (event: AgentEvent) => void;
  /** Biaya yang sudah terpakai hari ini. */
  dailyCostSoFar: () => number;
  /** Setelah giliran selesai. */
  onTurnFinished?: (summary: TurnSummary) => void;
  now?: () => Date;
}

interface TurnState {
  usage: Usage;
  toolNames: string[];
  stoppedBy: TurnSummary["stoppedBy"];
}

export class AgentLoop {
  private readonly opts: AgentLoopOptions;

  constructor(opts: AgentLoopOptions) {
    this.opts = opts;
  }

  async run(sessionId: string, userText: string, signal: AbortSignal): Promise<TurnSummary> {
    const { sessions, config, providers, tools, policy, contextEngine } = this.opts;
    const session = sessions.get(sessionId);
    if (!session) throw new OmopError("DB_ERROR", `Sesi ${sessionId} tidak ada.`);

    // 1. Simpan pesan pengguna dan event.
    sessions.addMessage({
      sessionId,
      role: "user",
      content: userText,
      blocks: [{ type: "text", text: userText }],
    });

    const prompt = await this.opts.buildSystemPrompt(sessionId);
    const tainted = session.tainted === 1;

    const context: ToolContext = {
      sessionId,
      workspace: session.workspace ?? config.workspace.default,
      origin: session.channel === "telegram" ? "telegram" : session.channel === "scheduler" ? "scheduler" : "cli",
      tainted,
      now: this.opts.now ?? (() => new Date()),
      signal,
    };

    const state: TurnState = {
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      toolNames: [],
      stoppedBy: "end_turn",
    };

    const provider = this.resolveProvider();
    const availableTools = tools.available(context);
    const toolDefs = availableTools.map(toDefinition);

    const turnStart = Date.now();
    const maxMinutes = config.agent.max_minutes_per_turn;
    let iteration = 0;
    const identicalCalls = new Map<string, number>();
    let history: Message[] = sessions.toMessages(sessions.messages(sessionId));
    policy.resetDenialCounts();

    // 3. Loop sampai selesai.
    while (true) {
      // a. Batas.
      if (signal.aborted) {
        state.stoppedBy = "cancelled";
        break;
      }
      iteration++;
      if (iteration > config.agent.max_iterations) {
        state.stoppedBy = "limit";
        this.opts.emit({
          type: "text_delta",
          text: `\n\n[Batas iterasi ${config.agent.max_iterations} tercapai. Progres disimpan.]`,
        });
        break;
      }
      const elapsedMinutes = (Date.now() - turnStart) / 60000;
      if (elapsedMinutes > maxMinutes) {
        state.stoppedBy = "limit";
        this.opts.emit({
          type: "text_delta",
          text: `\n\n[Batas waktu ${maxMinutes} menit tercapai. Progres disimpan.]`,
        });
        break;
      }
      if (state.usage.costUsd > config.agent.max_cost_usd_per_turn) {
        state.stoppedBy = "limit";
        this.opts.emit({
          type: "text_delta",
          text: `\n\n[Batas biaya giliran $${config.agent.max_cost_usd_per_turn} tercapai.]`,
        });
        break;
      }
      if (this.opts.dailyCostSoFar() + state.usage.costUsd > config.agent.max_cost_usd_per_day) {
        state.stoppedBy = "limit";
        this.opts.emit({
          type: "text_delta",
          text: `\n\n[Batas biaya harian $${config.agent.max_cost_usd_per_day} tercapai. Butuh keputusan pengguna.]`,
        });
        break;
      }

      // b. Context engine.
      const prepared = await contextEngine.prepare(history, {
        contextTokens: provider.capabilities(config.model.name).contextTokens,
        usedTokens: state.usage.inputTokens,
      });
      if (prepared !== history) {
        history = prepared;
      }

      this.opts.emit({
        type: "status",
        contextPercent: Math.min(
          100,
          Math.round(
            (state.usage.inputTokens /
              Math.max(1, provider.capabilities(config.model.name).contextTokens)) *
              100,
          ),
        ),
        costUsd: state.usage.costUsd,
        tainted,
      });

      // c. Panggil provider.
      const request = {
        model: config.model.name,
        system: prompt.system,
        messages: prepared,
        tools: toolDefs,
        maxTokens: config.model.max_tokens,
        ...(config.model.effort ? { effort: config.model.effort } : {}),
      };

      let assistantMessage: Message | null = null;
      let stopReason: Message extends never ? never : import("../core/types.js").StopReason = "end_turn";
      try {
        for await (const ev of provider.stream(request, signal)) {
          if (ev.type === "text_delta") {
            this.opts.emit({ type: "text_delta", text: ev.text });
            continue;
          }
          assistantMessage = ev.message;
          stopReason = ev.stopReason;
          state.usage.inputTokens += ev.usage.inputTokens;
          state.usage.outputTokens += ev.usage.outputTokens;
          state.usage.costUsd += ev.usage.costUsd;
        }
      } catch (err) {
        if (signal.aborted) {
          state.stoppedBy = "cancelled";
          break;
        }
        // e. Retry/fallback ditangani caller; di sini laporkan.
        const msg = err instanceof OmopError ? err.message : String(err);
        this.opts.emit({ type: "text_delta", text: `\n\n[Error provider: ${msg}]` });
        state.stoppedBy = "other";
        break;
      }

      if (!assistantMessage) {
        state.stoppedBy = "other";
        break;
      }

      // d. Simpan pesan asisten.
      sessions.addMessage({
        sessionId,
        role: "assistant",
        content: assistantMessage.content
          .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
          .join("\n"),
        blocks: assistantMessage.content,
        usage: state.usage,
      });
      history.push(assistantMessage);

      // e. Stop reason.
      if (stopReason === "max_tokens") {
        this.opts.emit({
          type: "text_delta",
          text: "\n\n[Respons terpotong karena batas token. Tool dari pesan ini tidak dijalankan.]",
        });
        state.stoppedBy = "max_tokens";
        break;
      }
      if (stopReason === "refusal") {
        state.stoppedBy = "refusal";
        break;
      }
      if (stopReason !== "tool_use") {
        state.stoppedBy = stopReason;
        break;
      }

      // f. Validasi dan jalankan tool call lewat policy.
      const toolCalls = extractToolCalls(assistantMessage);
      if (toolCalls.length === 0) {
        state.stoppedBy = "other";
        break;
      }

      const results: ContentBlock[] = [];
      for (const call of toolCalls) {
        if (signal.aborted) {
          results.push({
            type: "tool_result",
            toolUseId: call.id,
            content: "Dibatalkan.",
            isError: true,
          });
          continue;
        }

        // Deteksi loop: tool call identik berturut-turut.
        const callKey = `${call.name}:${JSON.stringify(call.input)}`;
        const seen = identicalCalls.get(callKey) ?? 0;
        identicalCalls.set(callKey, seen + 1);
        if (seen + 1 > config.agent.max_identical_tool_calls) {
          this.opts.emit({
            type: "text_delta",
            text: `\n\n[Loop terdeteksi: ${call.name} dipanggil ${seen + 1} kali dengan argumen sama. Dihentikan.]`,
          });
          state.stoppedBy = "loop";
          results.push({
            type: "tool_result",
            toolUseId: call.id,
            content: "Dihentikan: pemanggilan identik berulang tanpa progres.",
            isError: true,
          });
          break;
        }

        const tool = this.opts.tools.get(call.name);
        if (!tool) {
          results.push({
            type: "tool_result",
            toolUseId: call.id,
            content: `Tool "${call.name}" tidak tersedia.`,
            isError: true,
          });
          continue;
        }

        // Klasifikasi risiko oleh tool itu sendiri.
        let classification;
        try {
          classification = {
            name: tool.name,
            baseRisk: tool.classifyRisk(call.input, context),
            readOnly: tool.readOnly,
            sideEffect: tool.sideEffect,
            producesUntrustedContent: tool.producesUntrustedContent,
          };
        } catch {
          classification = {
            name: tool.name,
            baseRisk: "high" as const,
            readOnly: tool.readOnly,
            sideEffect: tool.sideEffect,
            producesUntrustedContent: tool.producesUntrustedContent,
          };
        }

        const decision = await policy.authorize(call, context, classification);
        if (decision.outcome === "deny") {
          this.opts.emit({
            type: "tool_finished",
            callId: call.id,
            isError: true,
          });
          results.push({
            type: "tool_result",
            toolUseId: call.id,
            content: `Ditolak oleh policy: ${decision.reason}`,
            isError: true,
          });
          continue;
        }

        // Validasi input.
        let validated: unknown;
        try {
          validated = validateInput(tool.inputSchema, call.input);
        } catch (err) {
          const msg = err instanceof OmopError ? err.message : String(err);
          results.push({
            type: "tool_result",
            toolUseId: call.id,
            content: `Input tidak valid: ${msg}`,
            isError: true,
          });
          continue;
        }

        this.opts.emit({
          type: "tool_started",
          callId: call.id,
          name: call.name,
          displayText: summarizeCall(call),
        });
        state.toolNames.push(call.name);

        try {
          const output = await tool.run(validated, context);
          const text =
            typeof output === "string" ? output : JSON.stringify(output, null, 2);
          const bounded = text.slice(0, config.agent.max_tool_output_chars);
          results.push({
            type: "tool_result",
            toolUseId: call.id,
            content: bounded,
            isError: false,
          });
          this.opts.emit({ type: "tool_finished", callId: call.id, isError: false });

          // Tool yang menghasilkan konten tidak tepercaya membuat sesi tainted.
          if (tool.producesUntrustedContent && !context.tainted) {
            this.opts.sessions.setTainted(sessionId, true);
            context.tainted = true;
          }
        } catch (err) {
          const msg = err instanceof OmopError ? err.message : String(err);
          results.push({
            type: "tool_result",
            toolUseId: call.id,
            content: `Tool error: ${msg}`,
            isError: true,
          });
          this.opts.emit({ type: "tool_finished", callId: call.id, isError: true });
        }
      }

      // g. Semua hasil tool dalam SATU pesan pengguna.
      const resultMessage: Message = {
        role: "user",
        content: results,
      };
      sessions.addMessage({
        sessionId,
        role: "user",
        content: results.map((r) => (r.type === "tool_result" ? r.content : "")).join("\n"),
        blocks: results,
      });
      history.push(resultMessage);

      if (state.stoppedBy === "loop" || signal.aborted) break;
    }

    // 4. Ringkasan giliran.
    const summary: TurnSummary = {
      sessionId,
      stoppedBy: state.stoppedBy,
      toolNames: state.toolNames,
      usage: state.usage,
      tainted: this.opts.sessions.isTainted(sessionId),
    };
    this.opts.emit({ type: "turn_finished", summary });
    this.opts.onTurnFinished?.(summary);
    return summary;
  }

  private resolveProvider(): ModelProvider {
    const { config, providers } = this.opts;
    return providers.get(config.model.provider);
  }
}

function extractToolCalls(message: Message): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const b of message.content) {
    if (b.type === "tool_use") calls.push({ id: b.id, name: b.name, input: b.input });
  }
  return calls;
}

function toDefinition(tool: Tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function summarizeCall(call: ToolCall): string {
  const input = call.input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["path", "command", "pattern", "query", "question"]) {
    const v = input[key];
    if (typeof v === "string") parts.push(`${key}=${v.slice(0, 120)}`);
  }
  return parts.length > 0 ? `${call.name} ${parts.join(" ")}` : call.name;
}
