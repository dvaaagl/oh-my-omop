/**
 * Validasi path workspace (SECURITY.md G5).
 * - Selesaikan symlink dengan realpath, pastikan masih di dalam workspace.
 * - Berlaku juga untuk file yang belum ada: periksa folder induknya.
 * - Tolak .env, *.pem, *.key, id_rsa, .npmrc, .git-credentials, null byte.
 * - Tolak file berisiko tinggi G13 saat menulis.
 */

import { realpathSync, existsSync } from "node:fs";
import { isAbsolute, relative, resolve, dirname, join, basename } from "node:path";
import { OmopError } from "../core/errors.js";

/** Ekstensi dan nama file yang tidak boleh disentuh tool file. */
const FORBIDDEN_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".git-credentials",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "id_dsa",
  "id_ecdsa",
]);

const FORBIDDEN_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];

/** Direktori dan file berisiko tinggi G13 — penulisan selalu butuh approval tinggi. */
export const G13_HIGH_RISK_PATHS = [
  /^\.git\//,
  /^\.git$/,
  /^\.husky\//,
  /^\.vscode\//,
  /^\.idea\//,
  /^\.github\/workflows\//,
  /^Makefile$/,
  /^OMOP\.md$/,
  /^AGENTS\.md$/,
];

export function isForbiddenPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? "";
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  const lower = base.toLowerCase();
  if (lower.startsWith(".env")) return true;
  return FORBIDDEN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isG13HighRisk(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return G13_HIGH_RISK_PATHS.some((re) => re.test(normalized));
}

export interface ResolvedPath {
  /** Path absolut yang sudah divalidasi. */
  absolute: string;
  /** Path relatif terhadap workspace, pakai "/" sebagai separator. */
  relative: string;
}

/**
 * Resolusi dan validasi path terhadap workspace.
 * Melempar OmopError kalau keluar workspace atau terlarang.
 *
 * Untuk file yang belum ada, folder induk yang di-realpath, lalu nama
 * file digabung kembali. Dengan begitu path relatif tetap menunjuk ke
 * file, bukan ke folder induknya.
 */
export function resolveWorkspacePath(workspace: string, userPath: string): ResolvedPath {
  if (userPath.includes("\0")) {
    throw new OmopError("PATH_FORBIDDEN", "Path mengandung null byte.");
  }

  const workspaceAbs = realpathOrSelf(resolve(workspace));
  const candidate = isAbsolute(userPath) ? resolve(userPath) : resolve(workspaceAbs, userPath);

  // Kalau path sudah ada, realpath langsung (menyelesaikan symlink).
  // Kalau belum, realpath folder induknya lalu gabung dengan nama file.
  let realCandidate: string;
  if (existsSync(candidate)) {
    realCandidate = realpathOrSelf(candidate);
  } else {
    const parent = dirname(candidate);
    const realParent = realpathOrSelf(parent);
    realCandidate = join(realParent, basename(candidate));
  }

  const rel = relative(workspaceAbs, realCandidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new OmopError(
      "PATH_OUTSIDE_WORKSPACE",
      `Path keluar dari workspace: ${userPath}`,
    );
  }

  const relPath = rel === "" ? "." : rel.split(/[\\/]/).join("/");
  return { absolute: realCandidate, relative: relPath };
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Validasi untuk penulisan file: workspace + terlarang + G13. */
export function validateWritePath(workspace: string, userPath: string): ResolvedPath {
  const resolved = resolveWorkspacePath(workspace, userPath);
  if (resolved.relative !== "." && isForbiddenPath(resolved.relative)) {
    throw new OmopError(
      "PATH_FORBIDDEN",
      `File sensitif tidak boleh diubah: ${resolved.relative}`,
    );
  }
  return resolved;
}
