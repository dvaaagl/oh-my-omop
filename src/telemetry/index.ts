/**
 * Telemetry: usage, logs, trace (CLI.md: omop usage, omop logs, omop trace).
 *
 * - Biaya dan token dihitung dari tabel messages.
 * - Trace merekam model dan tool yang dipakai setiap panggilan.
 * - `omop trace <session> --prompt` memperlihatkan prompt yang dikirim,
 *   setelah sensor rahasia (G6).
 */

import type { Database } from "../storage/db.js";
import { redactSecrets } from "../policy/redaction.js";

export interface UsageSummary {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  messages: number;
  sessions: number;
  byDay: { day: string; costUsd: number; inputTokens: number; outputTokens: number }[];
}

export class Telemetry {
  constructor(private readonly db: Database) {}

  usage(): UsageSummary {
    const total = this.db.db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS inp, " +
          "COALESCE(SUM(output_tokens), 0) AS outp, COUNT(*) AS n FROM messages",
      )
      .get() as { cost: number; inp: number; outp: number; n: number };

    const sessions = this.db.db
      .prepare("SELECT COUNT(*) AS n FROM sessions")
      .get() as { n: number };

    const byDay = this.db.db
      .prepare(
        "SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(cost_usd), 0) AS cost_usd, " +
          "COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens " +
          "FROM messages GROUP BY day ORDER BY day DESC LIMIT 30",
      )
      .all() as { day: string; cost_usd: number; input_tokens: number; output_tokens: number }[];

    return {
      totalCostUsd: total.cost,
      inputTokens: total.inp,
      outputTokens: total.outp,
      messages: total.n,
      sessions: sessions.n,
      byDay: byDay.map((r) => ({
        day: r.day,
        costUsd: r.cost_usd,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
      })),
    };
  }

  /** Ringkasan satu sesi: pesan, biaya, tool yang dipakai. */
  sessionTrace(sessionId: string): {
    session: Record<string, unknown> | undefined;
    messages: Record<string, unknown>[];
    toolNames: string[];
    costUsd: number;
  } {
    const session = this.db.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;

    const messages = this.db.db
      .prepare("SELECT id, role, input_tokens, output_tokens, cost_usd, created_at FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(sessionId) as Record<string, unknown>[];

    const toolNames: string[] = [];
    for (const m of messages) {
      const blocks = this.db.db
        .prepare("SELECT blocks_json FROM messages WHERE id = ?")
        .get(String(m.id)) as { blocks_json: string } | undefined;
      if (!blocks) continue;
      try {
        const parsed = JSON.parse(blocks.blocks_json) as { type: string; name?: string }[];
        for (const b of parsed) {
          if (b.type === "tool_use" && b.name) toolNames.push(b.name);
        }
      } catch {
        /* noop */
      }
    }

    const cost = this.db.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM messages WHERE session_id = ?")
      .get(sessionId) as { c: number };

    return { session, messages, toolNames, costUsd: cost.c };
  }

  /**
   * Prompt yang dikirim ke provider untuk sesi, setelah sensor rahasia.
   * Dibangun ulang dari pesan tersimpan.
   */
  promptFor(sessionId: string, showPrompt: boolean): string {
    if (!showPrompt) {
      return "(pakai --prompt untuk melihat isi prompt)";
    }
    const rows = this.db.db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at LIMIT 50")
      .all(sessionId) as { role: string; content: string }[];
    return redactSecrets(
      rows.map((r) => `${r.role}: ${r.content.slice(0, 500)}`).join("\n\n"),
    );
  }

  /** Audit log terbaru. */
  recentAudit(limit = 50): Record<string, unknown>[] {
    return this.db.db
      .prepare("SELECT seq, action, detail_json, created_at FROM audit_log ORDER BY seq DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
  }
}
