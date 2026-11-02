/**
 * Checkpoint dan /undo (FEATURES.md bagian 2; SECURITY.md G13).
 *
 * - Sebelum file_write dan perintah shell non-baca, simpan snapshot
 *   workspace di shadow Git repo pada OMOP_HOME/checkpoints/<hash>/.
 * - Repo milik pengguna tidak disentuh.
 * - File yang dilindungi G5 (secrets, .env, private key) tidak ikut disimpan.
 * - Restore selalu minta konfirmasi dan membuat checkpoint baru dulu.
 * - Aksi di luar workspace tidak bisa dibatalkan.
 * - Checkpoint disimpan 30 hari.
 *
 * Shadow repo berjalan tanpa hook, fsmonitor, pager, dan external diff
 * (G13), supaya file .git/hooks milik pengguna tidak pernah dijalankan.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../storage/db.js";

/** File yang tidak pernah ikut checkpoint (G5). */
const PROTECTED = [
  ".env",
  ".npmrc",
  ".git-credentials",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "secrets.enc",
  "secret.key",
];

const PROTECTED_EXT = [".pem", ".key", ".p12", ".pfx"];

export interface Checkpoint {
  id: string;
  workspace: string;
  commit: string;
  createdAt: string;
  note: string;
}

export interface CheckpointOptions {
  db: Database;
  checkpointsDir: string;
  retentionDays?: number;
  now?: () => Date;
}

export class CheckpointStore {
  private readonly db: Database;
  private readonly dir: string;
  private readonly retentionDays: number;
  private readonly now: () => Date;

  constructor(opts: CheckpointOptions) {
    this.db = opts.db;
    this.dir = opts.checkpointsDir;
    this.retentionDays = opts.retentionDays ?? 30;
    this.now = opts.now ?? (() => new Date());
    mkdirSync(this.dir, { recursive: true });
  }

  private repoDir(workspace: string): string {
    const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
    return join(this.dir, hash);
  }

  private git(repo: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        // Matikan semua hal yang bisa menjalankan kode dari repo pengguna (G13).
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        HOME: repo,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  private ensureRepo(workspace: string): string {
    const repo = this.repoDir(workspace);
    if (!existsSync(join(repo, ".git"))) {
      mkdirSync(repo, { recursive: true });
      this.git(repo, ["init", "--quiet"]);
      this.git(repo, ["config", "core.hooksPath", "/dev/null"]);
      this.git(repo, ["config", "core.fsmonitor", "false"]);
      this.git(repo, ["config", "core.pager", "cat"]);
      this.git(repo, ["config", "diff.external", ""]);
      this.git(repo, ["config", "user.email", "omop@local"]);
      this.git(repo, ["config", "user.name", "Omop Checkpoint"]);
    }
    return repo;
  }

  /** Buat checkpoint dari keadaan workspace sekarang. */
  create(workspace: string, note = ""): Checkpoint {
    if (!existsSync(workspace)) {
      throw new Error(`Workspace tidak ada: ${workspace}`);
    }
    const repo = this.ensureRepo(workspace);

    // Salin file yang boleh di-checkpoint.
    const files = this.collectFiles(workspace);
    for (const rel of files) {
      const src = join(workspace, rel);
      const dest = join(repo, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      execFileSync("cp", ["-p", src, dest]);
    }

    this.git(repo, ["add", "-A"]);
    const hasStaged = this.git(repo, ["diff", "--cached", "--name-only"]);
    const createdAt = this.now().toISOString();
    let commit = "empty";
    if (hasStaged.length > 0) {
      this.git(repo, ["commit", "--quiet", "--allow-empty", "-m", `checkpoint ${createdAt} ${note}`]);
      commit = this.git(repo, ["rev-parse", "HEAD"]);
    }

    const id = createHash("sha256").update(`${workspace}:${commit}:${createdAt}`).digest("hex").slice(0, 16);
    this.db.db
      .prepare(
        "INSERT OR REPLACE INTO checkpoints (id, workspace, commit_sha, created_at, note) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, workspace, commit, createdAt, note);
    return { id, workspace, commit, createdAt, note };
  }

  list(workspace?: string): Checkpoint[] {
    const rows = workspace
      ? (this.db.db
          .prepare("SELECT * FROM checkpoints WHERE workspace = ? ORDER BY created_at DESC")
          .all(workspace) as Record<string, unknown>[])
      : (this.db.db
          .prepare("SELECT * FROM checkpoints ORDER BY created_at DESC")
          .all() as Record<string, unknown>[]);
    return rows.map((r) => ({
      id: String(r.id),
      workspace: String(r.workspace),
      commit: String(r.commit_sha),
      createdAt: String(r.created_at),
      note: String(r.note ?? ""),
    }));
  }

  /**
   * Pulihkan workspace ke checkpoint.
   * Selalu buat checkpoint keadaan saat ini dulu, supaya bisa dibatalkan lagi.
   */
  restore(id: string): Checkpoint {
    const cp = this.get(id);
    if (!cp) throw new Error(`Checkpoint ${id} tidak ada.`);

    // Checkpoint keadaan saat ini dulu.
    const safety = this.create(cp.workspace, `sebelum restore ${id}`);

    const repo = this.repoDir(cp.workspace);
    if (cp.commit !== "empty") {
      this.git(repo, ["reset", "--hard", cp.commit]);
      // Salin balik ke workspace.
      const files = this.collectFiles(repo).filter((f) => f !== ".git");
      for (const rel of files) {
        const src = join(repo, rel);
        const dest = join(cp.workspace, rel);
        mkdirSync(join(dest, ".."), { recursive: true });
        execFileSync("cp", ["-p", src, dest]);
      }
    }
    return safety;
  }

  get(id: string): Checkpoint | undefined {
    const row = this.db.db
      .prepare("SELECT * FROM checkpoints WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      workspace: String(row.workspace),
      commit: String(row.commit_sha),
      createdAt: String(row.created_at),
      note: String(row.note ?? ""),
    };
  }

  /** Hapus checkpoint lebih tua dari retensi. */
  gc(): number {
    const cutoff = new Date(this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const stale = this.db.db
      .prepare("SELECT id FROM checkpoints WHERE created_at < ?")
      .all(cutoff) as { id: string }[];
    for (const row of stale) {
      this.db.db.prepare("DELETE FROM checkpoints WHERE id = ?").run(row.id);
    }
    return stale.length;
  }

  private collectFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (abs: string, rel: string, depth: number): void => {
      if (depth > 10) return;
      let items: string[];
      try {
        items = readdirSync(abs);
      } catch {
        return;
      }
      for (const item of items) {
        if (item === ".git" || item === "node_modules") continue;
        if (this.isProtected(rel === "" ? item : `${rel}/${item}`)) continue;
        const childAbs = join(abs, item);
        const childRel = rel === "" ? item : `${rel}/${item}`;
        let isDir = false;
        try {
          isDir = statSync(childAbs).isDirectory();
        } catch {
          continue;
        }
        if (isDir) walk(childAbs, childRel, depth + 1);
        else out.push(childRel);
      }
    };
    walk(root, "", 1);
    return out;
  }

  private isProtected(rel: string): boolean {
    const base = rel.split("/").pop() ?? "";
    if (PROTECTED.includes(base)) return true;
    return PROTECTED_EXT.some((ext) => base.toLowerCase().endsWith(ext));
  }
}
