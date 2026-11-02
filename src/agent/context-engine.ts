/**
 * Context engine (FLOW.md bagian 8).
 *
 * Sebelum memanggil model:
 * - Kalau konteks melebihi 70% budget, beri kesempatan menyimpan info
 *   penting ke memori, lalu ringkas giliran tengah.
 * - Pertahankan pesan pertama dan giliran terbaru.
 * - Kompresi membuat sesi turunan yang tertaut ke sesi lama.
 * - Riwayat asli tidak dihapus.
 * - Kompresi tidak boleh memutus pasangan tool call dan tool result.
 */

import type { Message, TokenBudget } from "../core/types.js";
import { hashStable } from "./prompt-builder.js";

export interface ContextEngineOptions {
  /** Model pembantu untuk ringkasan. */
  summarize: (messages: Message[]) => Promise<string>;
  /** Batas persentase sebelum kompresi. */
  threshold?: number;
  /** Jumlah giliran terakhir yang selalu dipertahankan. */
  keepRecentTurns?: number;
}

export class ContextEngine {
  private readonly summarize: (messages: Message[]) => Promise<string>;
  private readonly threshold: number;
  private readonly keepRecent: number;

  constructor(opts: ContextEngineOptions) {
    this.summarize = opts.summarize;
    this.threshold = opts.threshold ?? 0.7;
    this.keepRecent = opts.keepRecentTurns ?? 6;
  }

  async prepare(messages: Message[], budget: TokenBudget): Promise<Message[]> {
    if (budget.contextTokens <= 0) return messages;
    const usedPercent = budget.usedTokens / budget.contextTokens;
    if (usedPercent < this.threshold) return messages;
    if (messages.length <= this.keepRecent + 1) return messages;

    // Pesan pertama selalu dipertahankan (pesan pengguna awal).
    const head = messages[0];
    const tail = messages.slice(-this.keepRecent);
    const middle = messages.slice(1, messages.length - this.keepRecent);

    if (middle.length === 0) return messages;

    const summary = await this.summarize(middle);

    const summaryMessage: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Ringkasan percakapan sebelumnya (dibuat oleh harness, bukan pesan pengguna baru):\n\n${summary}\n\n` +
            `Lanjutkan pekerjaan berdasarkan ringkasan ini dan pesan terbaru di bawah.`,
        },
      ],
    };

    const prepared: Message[] = [];
    if (head) prepared.push(head);
    prepared.push(summaryMessage);
    prepared.push(...ensureToolPairs(tail));

    return prepared;
  }
}

/**
 * Pastikan setiap tool_use punya tool_result pasangannya.
 * Pair yang putus di awal atau akhir slice dibuang.
 */
export function ensureToolPairs(messages: Message[]): Message[] {
  const out: Message[] = [];
  const pending = new Set<string>();

  for (const m of messages) {
    if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "tool_use") pending.add(b.id);
      }
      out.push(m);
      continue;
    }
    // user
    const keptBlocks: Message["content"] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        if (pending.has(b.toolUseId)) {
          keptBlocks.push(b);
          pending.delete(b.toolUseId);
        }
        continue;
      }
      keptBlocks.push(b);
    }
    if (keptBlocks.length === 0) continue;
    out.push({ role: "user", content: keptBlocks });
  }

  // Buang tool_use yang tidak punya pasangan (ada di pesan assistant terakhir).
  if (pending.size > 0) {
    const cleaned: Message[] = [];
    for (const m of out) {
      if (m.role !== "assistant") {
        cleaned.push(m);
        continue;
      }
      const blocks = m.content.filter(
        (b) => !(b.type === "tool_use" && pending.has(b.id)),
      );
      if (blocks.length === 0) continue;
      cleaned.push({ role: "assistant", content: blocks });
    }
    return cleaned;
  }

  return out;
}

export { hashStable };
