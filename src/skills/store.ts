/**
 * Skill system (ARCHITECTURE.md bagian 9.3, 9.4).
 *
 * Format mengikuti standar Agent Skills:
 *   OMOP_HOME/skills/<kategori>/<nama>/SKILL.md
 *
 * Hanya indeks (nama + deskripsi) yang selalu masuk prompt.
 * Isi lengkap dimuat saat dibutuhkan lewat skill_view.
 * Skill pihak ketiga diperlakukan sebagai kode tidak tepercaya.
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import type { OmopPaths } from "../core/paths.js";
import type { Database } from "../storage/db.js";
import { OmopError } from "../core/errors.js";
import { scanContent } from "../policy/redaction.js";

export interface SkillIndexEntry {
  name: string;
  category: string;
  description: string;
  dir: string;
  trust: "builtin" | "trusted" | "community";
}

export interface SkillContent {
  name: string;
  content: string;
  files: string[];
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  body: string;
}

export function parseSkillFile(raw: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    return { body: raw };
  }
  const [, frontmatter, body] = match;
  const result: ParsedFrontmatter = { body: body ?? "" };
  for (const line of (frontmatter ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === "name") result.name = unquote(value ?? "");
    if (key === "description") result.description = unquote(value ?? "");
  }
  return result;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export class SkillStore {
  private readonly paths: OmopPaths;
  private readonly db: Database;

  constructor(paths: OmopPaths, db: Database) {
    this.paths = paths;
    this.db = db;
  }

  /** Pindai semua skill di OMOP_HOME/skills dan skills bawaan repo. */
  index(builtinDirs: string[] = []): SkillIndexEntry[] {
    const entries: SkillIndexEntry[] = [];
    const seen = new Set<string>();
    const scan = (root: string, trust: "builtin" | "trusted" | "community"): void => {
      if (!existsSync(root)) return;
      for (const category of safeReaddir(root)) {
        const catDir = join(root, category);
        let isDir = false;
        try {
          isDir = statSync(catDir).isDirectory();
        } catch {
          continue;
        }
        if (!isDir) continue;
        for (const skillName of safeReaddir(catDir)) {
          const dir = join(catDir, skillName);
          const skillFile = join(dir, "SKILL.md");
          if (!existsSync(skillFile)) continue;
          if (seen.has(`${category}/${skillName}`)) continue;
          let raw: string;
          try {
            raw = readFileSync(skillFile, "utf8");
          } catch {
            continue;
          }
          const parsed = parseSkillFile(raw);
          entries.push({
            name: parsed.name ?? skillName,
            category,
            description: parsed.description ?? "(tanpa deskripsi)",
            dir,
            trust,
          });
          seen.add(`${category}/${skillName}`);
        }
      }
    };
    for (const dir of builtinDirs) scan(dir, "builtin");
    scan(this.paths.skills, "trusted");
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Indeks ringkas untuk prompt. */
  indexSummary(builtinDirs: string[] = []): string {
    const entries = this.index(builtinDirs);
    if (entries.length === 0) return "(tidak ada skill)";
    return entries
      .map((e) => `- ${e.name} [${e.category}/${e.trust}]: ${e.description}`)
      .join("\n");
  }

  find(name: string, builtinDirs: string[] = []): SkillIndexEntry | undefined {
    return this.index(builtinDirs).find((e) => e.name === name);
  }

  /** Muat isi SKILL.md. */
  view(name: string, builtinDirs: string[] = [], filePath?: string): SkillContent {
    const entry = this.find(name, builtinDirs);
    if (!entry) {
      throw new OmopError("TOOL_ERROR", `Skill "${name}" tidak ditemukan.`);
    }
    if (filePath) {
      const safe = normalizeRelative(filePath);
      const target = join(entry.dir, safe);
      if (!target.startsWith(entry.dir)) {
        throw new OmopError("PATH_FORBIDDEN", "Path file skill keluar dari direktori skill.");
      }
      if (!existsSync(target)) {
        throw new OmopError("TOOL_ERROR", `File "${safe}" tidak ada di skill ${name}.`);
      }
      return {
        name,
        content: readFileSync(target, "utf8"),
        files: listFiles(entry.dir),
      };
    }
    const skillFile = join(entry.dir, "SKILL.md");
    const raw = readFileSync(skillFile, "utf8");
    const scan = scanContent(raw);
    if (!scan.ok) {
      throw new OmopError(
        "TAINTED_MEMORY",
        `Skill "${name}" gagal pemindaian: ${scan.findings.map((f) => f.rule).join(", ")}`,
      );
    }
    return { name, content: raw, files: listFiles(entry.dir) };
  }

  /** Buat skill baru (usulan; tetap perlu persetujuan pengguna di CLI). */
  create(category: string, name: string, content: string): string {
    validateSlug(category);
    validateSlug(name);
    const scan = scanContent(content);
    if (!scan.ok) {
      throw new OmopError(
        "TAINTED_MEMORY",
        `Isi skill gagal pemindaian: ${scan.findings.map((f) => f.rule).join(", ")}`,
      );
    }
    const dir = join(this.paths.skills, category, name);
    if (existsSync(join(dir, "SKILL.md"))) {
      throw new OmopError("TOOL_ERROR", `Skill ${name} sudah ada.`);
    }
    
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, "utf8");
    this.db.db
      .prepare(
        "INSERT INTO audit_log (id, action, detail_json, prev_hash, row_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        crypto.randomUUID(),
        "skill_create",
        JSON.stringify({ category, name }),
        this.lastHash(),
        "unverified",
        new Date().toISOString(),
      );
    return dir;
  }

  /** Tambah file pendukung ke skill. */
  writeFile(category: string, name: string, filePath: string, content: string): string {
    const safe = normalizeRelative(filePath);
    if (!safe.startsWith("references/") && !safe.startsWith("templates/") && !safe.startsWith("scripts/") && !safe.startsWith("assets/")) {
      throw new OmopError(
        "PATH_FORBIDDEN",
        "File pendukung harus di references/, templates/, scripts/, atau assets/.",
      );
    }
    const dir = join(this.paths.skills, category, name);
    const target = join(dir, safe);
    if (!target.startsWith(dir)) {
      throw new OmopError("PATH_FORBIDDEN", "Path keluar dari direktori skill.");
    }
    
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
    return target;
  }

  remove(category: string, name: string): void {
    
    const dir = join(this.paths.skills, category, name);
    if (!existsSync(dir)) {
      throw new OmopError("TOOL_ERROR", `Skill ${name} tidak ada.`);
    }
    rmSync(dir, { recursive: true, force: true });
  }

  private lastHash(): string {
    const row = this.db.db
      .prepare("SELECT row_hash FROM audit_log ORDER BY seq DESC LIMIT 1")
      .get() as { row_hash: string } | undefined;
    return row?.row_hash ?? "genesis";
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => !f.startsWith("."));
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let items: string[];
    try {
      items = readdirSync(abs);
    } catch {
      return;
    }
    for (const item of items) {
      const childAbs = join(abs, item);
      const childRel = rel === "" ? item : `${rel}/${item}`;
      let isDir = false;
      try {
        isDir = statSync(childAbs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(childAbs, childRel);
      else out.push(childRel);
    }
  };
  walk(dir, "");
  return out;
}

function normalizeRelative(p: string): string {
  const cleaned = p.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (cleaned.includes("..") || cleaned.startsWith("/")) {
    throw new OmopError("PATH_FORBIDDEN", "Path file tidak valid.");
  }
  return cleaned;
}

function validateSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new OmopError(
      "TOOL_INPUT_INVALID",
      `Nama "${slug}" harus lowercase, huruf/angka/tanda hubung.`,
    );
  }
}

export { relative };
