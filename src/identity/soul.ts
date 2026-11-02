/**
 * SOUL dan personality (ARCHITECTURE.md bagian 7).
 *
 * SOUL.md = identitas dan karakter agent, berlaku di semua project dan kanal.
 *
 * Boleh berisi: nama agent, nada bicara, tingkat keterusterangan, cara
 * menyikapi ketidakpastian dan perbedaan pendapat.
 * Tidak boleh berisi: detail project, jadwal, kredensial, daftar kemampuan.
 *
 * Aturan:
 * - Agent hanya boleh MENGUSULKAN perubahan; pengguna menyetujui lewat diff.
 * - Setiap versi disimpan supaya omop soul rollback bisa memulihkan.
 * - SOUL tidak bisa melemahkan policy — policy ditegakkan di luar prompt.
 * - Overlay /personality melewati pemindaian yang sama dengan SOUL.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OmopPaths } from "../core/paths.js";
import type { Database } from "../storage/db.js";
import { OmopError } from "../core/errors.js";
import { scanContent } from "../policy/redaction.js";

export const MAX_SOUL_CHARS = 8000;

/** Identitas bawaan kalau SOUL.md tidak ada, kosong, atau gagal dipindai. */
export const DEFAULT_SOUL = `# Omop

Kamu Omop, partner kerja yang tenang dan terus terang.

- Bicara dalam bahasa Indonesia yang natural, kecuali diminta lain.
- Langsung ke inti dan beri satu rekomendasi yang jelas.
- Kalau tidak yakin, katakan apa yang belum diketahui.
- Kalau pengguna keliru, koreksi dengan sopan dan beri alasannya.
`;

export interface SoulState {
  content: string;
  version: number;
  source: "file" | "default" | "personality";
}

export class SoulStore {
  private readonly paths: OmopPaths;
  private readonly db: Database;

  constructor(paths: OmopPaths, db: Database) {
    this.paths = paths;
    this.db = db;
  }

  /** Buat SOUL.md awal kalau belum ada. Tidak pernah menimpa file yang ada. */
  ensureInitial(): void {
    if (existsSync(this.paths.soul)) return;
    mkdirSync(this.paths.home, { recursive: true });
    writeFileSync(this.paths.soul, DEFAULT_SOUL, "utf8");
    this.saveVersion(DEFAULT_SOUL, "initial");
  }

  /** Muat SOUL dengan pemindaian dan fallback ke identitas bawaan. */
  load(personality?: string | null): SoulState {
    if (personality) {
      const overlayPath = join(this.paths.personalities, `${personality}.md`);
      if (existsSync(overlayPath)) {
        const raw = readFileSync(overlayPath, "utf8");
        const scan = scanContent(raw);
        if (scan.ok && raw.trim().length > 0) {
          return {
            content: raw.slice(0, MAX_SOUL_CHARS),
            version: this.currentVersion(),
            source: "personality",
          };
        }
      }
    }

    if (!existsSync(this.paths.soul)) {
      return { content: DEFAULT_SOUL, version: 0, source: "default" };
    }
    let raw: string;
    try {
      raw = readFileSync(this.paths.soul, "utf8");
    } catch {
      return { content: DEFAULT_SOUL, version: 0, source: "default" };
    }
    if (raw.trim().length === 0) {
      return { content: DEFAULT_SOUL, version: 0, source: "default" };
    }
    const scan = scanContent(raw);
    if (!scan.ok) {
      return { content: DEFAULT_SOUL, version: 0, source: "default" };
    }
    return {
      content: raw.slice(0, MAX_SOUL_CHARS),
      version: this.currentVersion(),
      source: "file",
    };
  }

  /** Tulis SOUL baru, simpan versi, dan catat audit. */
  propose(content: string, note = "manual"): number {
    const scan = scanContent(content);
    if (!scan.ok) {
      throw new OmopError(
        "TAINTED_MEMORY",
        `SOUL gagal pemindaian: ${scan.findings.map((f) => f.rule).join(", ")}`,
      );
    }
    if (content.length > MAX_SOUL_CHARS) {
      throw new OmopError(
        "LIMIT_REACHED",
        `SOUL terlalu panjang (${content.length} > ${MAX_SOUL_CHARS} karakter).`,
      );
    }
    mkdirSync(this.paths.home, { recursive: true });
    writeFileSync(this.paths.soul, content, "utf8");
    return this.saveVersion(content, note);
  }

  /** Ganti konten dan simpan versi baru. */
  private saveVersion(content: string, note: string): number {
    const next = this.currentVersion() + 1;
    this.db.db
      .prepare("INSERT INTO soul_versions (version, content, created_at) VALUES (?, ?, ?)")
      .run(next, content, new Date().toISOString());
    this.db.db
      .prepare(
        "INSERT INTO audit_log (id, action, detail_json, prev_hash, row_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        crypto.randomUUID(),
        "soul_update",
        JSON.stringify({ version: next, note }),
        this.lastHash(),
        "unverified",
        new Date().toISOString(),
      );
    return next;
  }

  currentVersion(): number {
    const row = this.db.db
      .prepare("SELECT MAX(version) AS v FROM soul_versions")
      .get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  history(): { version: number; created_at: string; preview: string }[] {
    return (
      this.db.db
        .prepare(
          "SELECT version, created_at, substr(content, 1, 120) AS preview FROM soul_versions ORDER BY version DESC",
        )
        .all() as { version: number; created_at: string; preview: string }[]
    );
  }

  /** Pulihkan versi tertentu. */
  rollback(version: number): number {
    const row = this.db.db
      .prepare("SELECT content FROM soul_versions WHERE version = ?")
      .get(version) as { content: string } | undefined;
    if (!row) {
      throw new OmopError("TOOL_ERROR", `Versi SOUL ${version} tidak ada.`);
    }
    mkdirSync(this.paths.home, { recursive: true });
    writeFileSync(this.paths.soul, row.content, "utf8");
    return this.saveVersion(row.content, `rollback to ${version}`);
  }

  /** Daftar personality overlay yang tersedia. */
  listPersonalities(): string[] {
    if (!existsSync(this.paths.personalities)) return [];
    try {
      return readdirSync(this.paths.personalities)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""));
    } catch {
      return [];
    }
  }

  private lastHash(): string {
    const row = this.db.db
      .prepare("SELECT row_hash FROM audit_log ORDER BY seq DESC LIMIT 1")
      .get() as { row_hash: string } | undefined;
    return row?.row_hash ?? "genesis";
  }
}
