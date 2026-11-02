/**
 * Memory store (FLOW.md bagian 9, SECURITY.md G7).
 *
 * - USER.md dan MEMORY.md di OMOP_HOME/memories/.
 * - Penulisan dari sesi tainted masuk antrean tinjauan.
 * - Batas ukuran ditegakkan: penulisan ditolak kalau penuh, agent harus
 *   merapikan entri lama. Tidak ada kompaksi diam-diam.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OmopPaths } from "../core/paths.js";
import { OmopError } from "../core/errors.js";
import type { Database } from "../storage/db.js";
import { scanContent, redactSecrets, wrapUntrusted } from "../policy/redaction.js";

export type MemoryTarget = "user" | "memory";

export interface MemoryEntry {
  target: MemoryTarget;
  text: string;
}

export interface MemoryStoreOptions {
  paths: OmopPaths;
  db: Database;
  userCharLimit?: number;
  memoryCharLimit?: number;
}

export class MemoryStore {
  private readonly paths: OmopPaths;
  private readonly db: Database;
  private readonly userLimit: number;
  private readonly memoryLimit: number;

  constructor(opts: MemoryStoreOptions) {
    this.paths = opts.paths;
    this.db = opts.db;
    this.userLimit = opts.userCharLimit ?? 1500;
    this.memoryLimit = opts.memoryCharLimit ?? 2500;
  }

  private fileFor(target: MemoryTarget): string {
    return join(this.paths.memories, target === "user" ? "USER.md" : "MEMORY.md");
  }

  private limitFor(target: MemoryTarget): number {
    return target === "user" ? this.userLimit : this.memoryLimit;
  }

  private read(target: MemoryTarget): string {
    const path = this.fileFor(target);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  }

  /** Snapshot untuk system prompt. */
  systemBlock(): { user: string; memory: string } {
    return { user: this.read("user"), memory: this.read("memory") };
  }

  /**
   * Tambah entri. Dari sesi tainted -> antrean tinjauan.
   * Mengembalikan status: saved | queued.
   */
  add(target: MemoryTarget, text: string, opts: { tainted: boolean }): "saved" | "queued" {
    const cleaned = redactSecrets(text.trim());
    if (cleaned.length === 0) {
      throw new OmopError("TOOL_INPUT_INVALID", "Entri memori kosong.");
    }
    const scan = scanContent(cleaned);
    if (!scan.ok) {
      throw new OmopError(
        "TAINTED_MEMORY",
        `Entri memori ditolak oleh pemindai: ${scan.findings.map((f) => f.rule).join(", ")}`,
      );
    }
    if (opts.tainted) {
      this.queue({ target, operation: "add", content: cleaned, trust: "untrusted" });
      return "queued";
    }

    const current = this.read(target);
    const entry = `- ${cleaned}`;
    const next = current.length === 0 ? entry : `${current}\n${entry}`;
    if (next.length > this.limitFor(target)) {
      throw new OmopError(
        "LIMIT_REACHED",
        `${target === "user" ? "USER.md" : "MEMORY.md"} penuh (${this.limitFor(target)} karakter). ` +
          "Rapikan entri lama dulu sebelum menambah.",
      );
    }
    mkdirSync(this.paths.memories, { recursive: true });
    writeFileSync(this.fileFor(target), next, "utf8");
    this.audit("memory_add", { target });
    return "saved";
  }

  /** Hapus entri yang cocok tepat satu kali. */
  remove(target: MemoryTarget, text: string): number {
    const current = this.read(target);
    const needle = text.trim();
    const lines = current.split("\n");
    const matches = lines.filter((l) => l.includes(needle));
    if (matches.length === 0) {
      throw new OmopError("TOOL_ERROR", `Entri tidak ditemukan di ${target}.`);
    }
    if (matches.length > 1) {
      throw new OmopError(
        "TOOL_ERROR",
        `Teks cocok ${matches.length} baris. Hapus harus cocok tepat satu kali.`,
      );
    }
    const kept = lines.filter((l) => !l.includes(needle));
    mkdirSync(this.paths.memories, { recursive: true });
    writeFileSync(this.fileFor(target), kept.join("\n"), "utf8");
    this.audit("memory_remove", { target });
    return 1;
  }

  list(target: MemoryTarget): string[] {
    return this.read(target)
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter((l) => l.length > 0);
  }

  /** Masukkan usulan ke antrean tinjauan. */
  queue(proposal: {
    target: MemoryTarget;
    operation: "add" | "patch" | "remove";
    content: string;
    trust: "trusted" | "untrusted";
  }): void {
    this.db.db
      .prepare(
        "INSERT INTO review_queue (id, target, operation, content, evidence_json, trust, status, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(
        crypto.randomUUID(),
        proposal.target,
        proposal.operation,
        proposal.content,
        JSON.stringify([]),
        proposal.trust,
        new Date().toISOString(),
      );
  }

  /** Terapkan usulan yang sudah disetujui. */
  applyApproved(id: string): void {
    const row = this.db.db
      .prepare("SELECT target, operation, content FROM review_queue WHERE id = ? AND status = 'pending'")
      .get(id) as { target: MemoryTarget; operation: string; content: string } | undefined;
    if (!row) throw new OmopError("TOOL_ERROR", `Usulan ${id} tidak ditemukan atau sudah diproses.`);
    if (row.operation === "add") {
      this.add(row.target, row.content, { tainted: false });
    } else if (row.operation === "remove") {
      this.remove(row.target, row.content);
    }
    this.db.db
      .prepare("UPDATE review_queue SET status = 'approved', decided_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  rejectProposal(id: string): void {
    this.db.db
      .prepare("UPDATE review_queue SET status = 'rejected', decided_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  listQueue(): { id: string; target: string; operation: string; content: string }[] {
    return this.db.db
      .prepare(
        "SELECT id, target, operation, content FROM review_queue WHERE status = 'pending' ORDER BY created_at",
      )
      .all() as { id: string; target: string; operation: string; content: string }[];
  }

  private audit(action: string, detail: Record<string, unknown>): void {
    this.db.db
      .prepare(
        "INSERT INTO audit_log (id, action, detail_json, prev_hash, row_hash, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        crypto.randomUUID(),
        action,
        JSON.stringify(detail),
        this.lastHash(),
        "unverified",
        new Date().toISOString(),
      );
  }

  private lastHash(): string {
    const row = this.db.db
      .prepare("SELECT row_hash FROM audit_log ORDER BY seq DESC LIMIT 1")
      .get() as { row_hash: string } | undefined;
    return row?.row_hash ?? "genesis";
  }
}

export { wrapUntrusted };
