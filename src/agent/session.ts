/**
 * Session store (FLOW.md bagian 16, AGENT.md bagian 3).
 *
 * - Riwayat bersifat append-only.
 * - Setiap tool_use wajib punya tool_result, termasuk saat ditolak.
 * - Saat sesi dilanjutkan setelah crash, tool_use tanpa hasil diberi
 *   hasil error "terputus", tidak dijalankan ulang otomatis.
 */

import type { ContentBlock, Message } from "../core/types.js";
import type { Database } from "../storage/db.js";

export interface SessionRow {
  id: string;
  parent_id: string | null;
  session_key: string;
  channel: string;
  workspace: string | null;
  prompt_hash: string | null;
  started_at: string;
  ended_at: string | null;
  tainted: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  blocks_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
}

export class SessionStore {
  constructor(private readonly db: Database) {}

  create(input: {
    sessionKey: string;
    channel: string;
    workspace: string | null;
    parentId?: string | null;
    promptHash?: string | null;
    tainted?: boolean;
  }): SessionRow {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.db
      .prepare(
        "INSERT INTO sessions (id, parent_id, session_key, channel, workspace, prompt_hash, started_at, tainted) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.parentId ?? null,
        input.sessionKey,
        input.channel,
        input.workspace,
        input.promptHash ?? null,
        now,
        input.tainted ? 1 : 0,
      );
    return this.get(id)!;
  }

  get(id: string): SessionRow | undefined {
    return this.db.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
  }

  /** Cari sesi aktif untuk session_key (hanya boleh satu). */
  findActive(sessionKey: string): SessionRow | undefined {
    return this.db.db
      .prepare("SELECT * FROM sessions WHERE session_key = ? AND ended_at IS NULL")
      .get(sessionKey) as SessionRow | undefined;
  }

  list(limit = 50): (SessionRow & { message_count: number })[] {
    return this.db.db
      .prepare(
        "SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count " +
          "FROM sessions s ORDER BY s.started_at DESC LIMIT ?",
      )
      .all(limit) as unknown as (SessionRow & { message_count: number })[];
  }

  end(id: string): void {
    this.db.db
      .prepare("UPDATE sessions SET ended_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  setTainted(id: string, tainted: boolean): void {
    this.db.db
      .prepare("UPDATE sessions SET tainted = ? WHERE id = ?")
      .run(tainted ? 1 : 0, id);
  }

  isTainted(id: string): boolean {
    const row = this.get(id);
    return row?.tainted === 1;
  }

  addMessage(input: {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    blocks: ContentBlock[];
    usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  }): string {
    const id = crypto.randomUUID();
    this.db.db
      .prepare(
        "INSERT INTO messages (id, session_id, role, content, blocks_json, input_tokens, output_tokens, cost_usd, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.sessionId,
        input.role,
        input.content,
        JSON.stringify(input.blocks),
        input.usage?.inputTokens ?? null,
        input.usage?.outputTokens ?? null,
        input.usage?.costUsd ?? null,
        new Date().toISOString(),
      );
    return id;
  }

  messages(sessionId: string, limit = 200): MessageRow[] {
    return this.db.db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?",
      )
      .all(sessionId, limit) as unknown as MessageRow[];
  }

  /** Ubah baris DB menjadi Message netral. */
  toMessages(rows: MessageRow[]): Message[] {
    const out: Message[] = [];
    for (const row of rows) {
      let blocks: ContentBlock[];
      try {
        blocks = JSON.parse(row.blocks_json) as ContentBlock[];
      } catch {
        blocks = [{ type: "text", text: row.content }];
      }
      out.push({ role: row.role, content: blocks });
    }
    return out;
  }

  /**
   * Setelah crash: tool_use tanpa tool_result diberi hasil error "terputus".
   * Tidak dijalankan ulang secara otomatis.
   */
  repairInterrupted(sessionId: string): number {
    const rows = this.messages(sessionId);
    let repaired = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      if (row.role !== "assistant") continue;
      let blocks: ContentBlock[];
      try {
        blocks = JSON.parse(row.blocks_json) as ContentBlock[];
      } catch {
        continue;
      }
      const toolUses = blocks.filter((b) => b.type === "tool_use");
      if (toolUses.length === 0) continue;
      const answered = new Set<string>();
      for (let j = i + 1; j < rows.length; j++) {
        const next = rows[j];
        if (!next || next.role !== "user") continue;
        let nextBlocks: ContentBlock[];
        try {
          nextBlocks = JSON.parse(next.blocks_json) as ContentBlock[];
        } catch {
          continue;
        }
        for (const b of nextBlocks) {
          if (b.type === "tool_result") answered.add(b.toolUseId);
        }
      }
      const missing = toolUses.filter((b) => b.type === "tool_use" && !answered.has(b.id));
      if (missing.length === 0) continue;

      const resultBlocks: ContentBlock[] = missing.map((b) =>
        b.type === "tool_use"
          ? {
              type: "tool_result",
              toolUseId: b.id,
              content: "Aksi terputus karena proses berhenti. Tidak dijalankan ulang otomatis.",
              isError: true,
            }
          : b,
      );
      this.addMessage({
        sessionId,
        role: "user",
        content: "[hasil tool terputus]",
        blocks: resultBlocks,
      });
      repaired += missing.length;
    }
    return repaired;
  }

  delete(id: string): void {
    this.db.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  /** Hapus sesi turunan lebih dulu karena foreign key. */
  deleteDeep(id: string): void {
    const children = this.db.db
      .prepare("SELECT id FROM sessions WHERE parent_id = ?")
      .all(id) as { id: string }[];
    for (const c of children) this.deleteDeep(c.id);
    this.delete(id);
  }
}
