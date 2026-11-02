/**
 * Redaction dan scanner (SECURITY.md G6, G7, G22).
 * Diterapkan SEBELUM data disimpan ke database, dikirim ke model,
 * masuk log, audit, atau balasan ke kanal.
 */

/** Nilai umpan (canary token) per profil. */
export interface CanaryTokens {
  values: string[];
}

const SECRET_PATTERNS: RegExp[] = [
  // Token Telegram bot: 8-10 digit, titik dua, lalu 35+ karakter.
  /\b\d{8,10}:[A-Za-z0-9_-]{35,}/g,
  // URL Telegram bot
  /\/bot\d{8,10}:[A-Za-z0-9_-]{35,}/g,
  // OpenAI / Anthropic style
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // GitHub
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  // AWS access key
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Password assignments
  /\b(password|passwd|pwd)\s*[:=]\s*\S+/gi,
  // Private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];

export const REDACTED = "[REDACTED]";

/** Sensor pola rahasia generik. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Sensor nilai rahasia yang tersimpan (dicocokkan apa adanya). */
export function redactValues(text: string, values: string[]): string {
  let out = text;
  for (const v of values) {
    if (v.length >= 6) {
      out = out.split(v).join(REDACTED);
    }
  }
  return out;
}

/** Sensor gabungan: nilai tersimpan + pola + canary token. */
export function redactAll(text: string, values: string[], canary?: CanaryTokens): string {
  let out = redactValues(text, values);
  if (canary) out = redactValues(out, canary.values);
  out = redactSecrets(out);
  return out;
}

// ── Unicode tersembunyi ─────────────────────────────────────────

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

export function hasHiddenUnicode(text: string): boolean {
  return ZERO_WIDTH.test(text) || BIDI.test(text);
}

export function stripHiddenUnicode(text: string): string {
  return text.replace(ZERO_WIDTH, "").replace(BIDI, "");
}

// ── Escape sequence terminal (G14) ──────────────────────────────

const ESCAPE_SEQ =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
const OSC_SEQ = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function sanitizeForTerminal(text: string): string {
  let out = text.replace(OSC_SEQ, "").replace(ESCAPE_SEQ, "");
  // Buang karakter kontrol lain kecuali \n dan \t.
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return out;
}

// ── Scanner injeksi untuk SOUL, memori, skill, aturan project (G7) ──

export type ScanSeverity = "info" | "warn" | "block";

export interface ScanFinding {
  rule: string;
  severity: ScanSeverity;
  excerpt: string;
}

const INJECTION_PATTERNS: { rule: string; re: RegExp; severity: ScanSeverity }[] = [
  { rule: "ignore_previous_instructions", re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|prompts?)/i, severity: "block" },
  { rule: "disregard_system", re: /disregard\s+(the\s+)?(system|previous)/i, severity: "block" },
  { rule: "you_are_now", re: /\byou\s+are\s+now\s+(a|an|the)?\s*(different|new|unrestricted|jailbroken)/i, severity: "warn" },
  { rule: "no_restrictions", re: /\b(no|without|remove)\s+(all\s+)?(restrictions?|limitations?|filters?|guardrails?)/i, severity: "warn" },
  { rule: "read_secrets_path", re: /\b(read|cat|open|print|baca|ambil)\b[^.\n]{0,40}\b(secrets?\.enc|secret\.key|\.env|id_rsa|\.npmrc|\.git-credentials)/i, severity: "block" },
  { rule: "exfiltrate_request", re: /\b(send|post|upload|exfiltrate|transmit|kirim|unggah)\b[^.\n]{0,60}\b(secret|credential|password|api[ _-]?key|token|\.env|private key|server)/i, severity: "block" },
  { rule: "override_policy", re: /\b(disable|bypass|override|weaken)\b[^.\n]{0,40}\b(policy|approval|sandbox|guardrail|permission)/i, severity: "block" },
  { rule: "credential_inline", re: /\b(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})\b/, severity: "block" },
  { rule: "telegram_token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35,}\b/, severity: "block" },
  { rule: "hidden_unicode", re: /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/, severity: "block" },
  { rule: "habit_poison", re: /\b(always|from now on|every time)\b[^.\n]{0,50}\b(without asking|automatically|no approval|skip approval)/i, severity: "warn" },
  { rule: "sensitive_inference", re: /\b(health|medical|religion|politics?|sexuality|financial situation)\b/i, severity: "warn" },
];

export interface ScanResult {
  ok: boolean;
  findings: ScanFinding[];
}

/**
 * Pindai konten sebelum disimpan/dimuat.
 * `ok=false` berarti ada temuan tingkat block.
 */
export function scanContent(text: string): ScanResult {
  const findings: ScanFinding[] = [];
  for (const { rule, re, severity } of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      findings.push({
        rule,
        severity,
        excerpt: m[0].slice(0, 80),
      });
    }
  }
  return { ok: !findings.some((f) => f.severity === "block"), findings };
}

/** Bungkus konten luar sebagai data tidak tepercaya (G1). */
export function wrapUntrusted(source: string, content: string): string {
  const safe = content
    .replace(/<\/untrusted_data>/gi, "&lt;/untrusted_data&gt;")
    .replace(/<untrusted_data/gi, "&lt;untrusted_data");
  return `<untrusted_data source="${escapeAttr(source)}">\n${safe}\n</untrusted_data>`;
}

function escapeAttr(value: string): string {
  return value.replace(/["<>]/g, (c) => ({ '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}
