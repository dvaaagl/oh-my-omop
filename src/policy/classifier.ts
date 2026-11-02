/**
 * Klasifikasi risiko perintah shell (SECURITY.md G3).
 *
 * | Tingkat | Contoh |
 * | Aman | ls, pwd, git status, git diff — tanpa metakarakter shell |
 * | Sedang | Perintah lain di dalam Docker |
 * | Tinggi | Hapus/pindah file, git push, curl, ssh, sudo, pipe ke interpreter, publish, semua perintah di backend lokal |
 * | Terlarang | secrets.enc, secret.key, OMOP_HOME, dump env, format disk, fork bomb |
 *
 * Regex tidak bisa menangkap semua bentuk perintah. Klasifikasi hanya
 * mengurangi risiko — batas sebenarnya adalah sandbox dan approval.
 * Perintah yang tidak dikenali TIDAK PERNAH dianggap aman.
 */

import type { RiskLevel } from "../core/types.js";

/** Perintah baca yang aman, hanya kalau argumennya juga aman. */
const SAFE_COMMANDS = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "find",
  "which",
  "echo",
  "date",
  "whoami",
  "hostname",
  "uname",
  "env",
  "printenv",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "node --version",
  "npm --version",
  "npm ls",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "remote",
  "rev-parse",
  "describe",
  "blame",
]);

/** Metakarakter yang menaikkan risiko. `~` dikecualikan karena aman di argumen seperti HEAD~1. */
const SHELL_METACHARS = /[;|&`$<>(){}[\]*?!\\'"]/;

/** Pola terlarang — selalu ditolak. */
const FORBIDDEN_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: "secret_store_access", re: /\b(secrets?\.enc|secret\.key)\b/i },
  { rule: "omop_home_access", re: /\$OMOP_HOME\b|\/\.omop\/|\.omop\/(config|secrets|state)/i },
  { rule: "env_dump", re: /\b(printenv|env)\b\s*$/i },
  { rule: "env_dump_redirect", re: /\benv\b[^|;]*>\s*\S+/i },
  { rule: "disk_format", re: /\b(mkfs|fdisk|dd\s+if=|parted|shred)\b/i },
  { rule: "fork_bomb", re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/ },
  { rule: "history_wipe", re: /\b(history\s+-c|shred\s+.*history|rm\s+.*\.bash_history)\b/i },
  { rule: "kill_harness", re: /\b(kill|pkill|killall)\b[^|;]*\b(omop|node|gateway|hermes)\b/i },
  { rule: "chmod_secrets", re: /\bchmod\b[^|;]*\b(secret|\.omop)\b/i },
  { rule: "ssh_key_read", re: /\b(cat|cp|scp|base64)\b[^|;]*\b(id_rsa|id_ed25519|\.ssh\/)/i },
  { rule: "credential_files", re: /\b(cat|cp|less|more|base64|xxd|strings)\b[^|;]*\b(\.env|\.npmrc|\.git-credentials|\.netrc)\b/i },
  { rule: "pipe_to_interpreter", re: /\|\s*(sudo\s+)?(ba|z|fi)?sh\b|\|\s*python[0-9.]*\b|\|\s*(node|ruby|perl)\b/i },
  { rule: "curl_pipe_shell", re: /\b(curl|wget)\b[^|;]*\|\s*(ba|z|fi)?sh\b/i },
  { rule: "eval_injection", re: /\beval\s+["$]/ },
];

/** Pola risiko tinggi. */
const HIGH_RISK_PATTERNS: RegExp[] = [
  /\brm\b/,
  /\brmdir\b/,
  /\bmv\b/,
  /\bdd\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\bsudo\b/,
  /\bsu\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bnpm\s+publish\b/,
  /\bdocker\s+push\b/,
  /\bgit\s+commit\b/,
  /\bsystemctl\b/,
  /\bservice\b/,
  /\bkill\b/,
  /\bpkill\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bcp\b/,
  /\btee\b/,
  /\bnohup\b/,
  /\bcrontab\b/,
  /\bexport\b/,
  /\bset\b/,
  /\bsource\b/,
  /\bnpm\s+install\b/,
  /\bnpm\s+ci\b/,
  /\bapt(-get)?\b/,
  /\bpip3?\s+install\b/,
  /\bgit\s+checkout\b/,
  /\bgit\s+switch\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+tag\b/,
  /\bgit\s+push\b/,
];

export interface ShellClassification {
  risk: RiskLevel;
  rule?: string;
  reason?: string;
}

/**
 * Klasifikasi perintah shell.
 * @param command perintah lengkap
 * @param backend "docker" atau "local" — local membuat semua perintah berisiko tinggi
 */
export function classifyShell(command: string, backend: "docker" | "local"): ShellClassification {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { risk: "high", rule: "empty", reason: "Perintah kosong." };
  }

  // Backend lokal: semua perintah berisiko tinggi (G5).
  if (backend === "local") {
    // Terlarang tetap terlarang.
    for (const { rule, re } of FORBIDDEN_PATTERNS) {
      if (re.test(trimmed)) {
        return { risk: "forbidden", rule, reason: `Perintah terlarang: ${rule}` };
      }
    }
    return { risk: "high", rule: "local_backend", reason: "Backend lokal: semua perintah berisiko tinggi." };
  }

  // Terlarang — diperiksa lebih dulu.
  for (const { rule, re } of FORBIDDEN_PATTERNS) {
    if (re.test(trimmed)) {
      return { risk: "forbidden", rule, reason: `Perintah terlarang: ${rule}` };
    }
  }

  // Aman hanya untuk perintah baca yang persis dikenal, tanpa metakarakter.
  if (isSafeCommand(trimmed)) {
    return { risk: "safe", rule: "known_read_only" };
  }

  // Tidak dikenali -> tinggi. Tidak pernah aman.
  for (const re of HIGH_RISK_PATTERNS) {
    if (re.test(trimmed)) {
      return { risk: "high", rule: "high_risk_pattern" };
    }
  }

  if (SHELL_METACHARS.test(trimmed)) {
    return { risk: "high", rule: "shell_metachar", reason: "Perintah memakai metakarakter shell." };
  }

  return { risk: "high", rule: "unrecognized", reason: "Perintah tidak dikenali; tidak dianggap aman." };
}

function isSafeCommand(command: string): boolean {
  if (SHELL_METACHARS.test(command)) return false;
  const parts = command.split(/\s+/);
  const head = parts[0];
  if (!head) return false;

  if (head === "git") {
    const sub = parts[1];
    if (!sub) return false;
    return SAFE_GIT_SUBCOMMANDS.has(sub);
  }

  if (SAFE_COMMANDS.has(head)) return true;
  // "git status" sebagai satu string sudah tercakup di atas.
  const joined = parts.slice(0, 2).join(" ");
  return SAFE_COMMANDS.has(joined);
}
