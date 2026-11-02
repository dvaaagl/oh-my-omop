/**
 * Policy engine (SECURITY.md G3).
 *
 * Urutan wajib: validasi input → klasifikasi risiko → penyesuaian taint →
 * keputusan → audit → eksekusi.
 *
 * Aturan keras:
 * - Error di mana pun dalam authorize menghasilkan DENY.
 * - Timeout dan pembatalan berarti tolak.
 * - Risiko tinggi: selalu minta izin, tanpa opsi "selalu".
 * - Sesi tainted: risiko sedang naik menjadi tinggi, izin tersimpan diabaikan.
 * - `deny` selalu menang, tidak bergantung urutan.
 * - `allow` hanya untuk risiko aman/sedang di sesi tidak tainted.
 * - Tidak ada mode yang mematikan approval.
 */

import { createHash } from "node:crypto";
import type {
  ApprovalRequest,
  PolicyDecision,
  RiskLevel,
  ToolCall,
  ToolContext,
} from "../core/types.js";
import { OmopError } from "../core/errors.js";
import type { Database } from "../storage/db.js";
import { hasHiddenUnicode, redactSecrets } from "./redaction.js";

export interface ToolClassification {
  name: string;
  baseRisk: RiskLevel;
  readOnly: boolean;
  sideEffect: boolean;
  producesUntrustedContent: boolean;
}

export interface PolicyEngineOptions {
  db: Database;
  /** Aturan permissions berpola per tool dari config. */
  permissions: Record<string, unknown>;
  /** Pola perintah yang selalu ditolak (approvals.deny). */
  denyPatterns: string[];
  /** Nama agent aktif (build, plan, general, explore). */
  agent: string;
  /** Approval yang diajukan ke kanal; resolve false = tolak. */
  requestApproval: (req: ApprovalRequest) => Promise<boolean>;
  /** Secret yang tersimpan, untuk sensor tampilan approval. */
  secretValues: () => string[];
  now?: () => Date;
}

interface ApprovalRow {
  id: string;
  tool_name: string;
  args_hash: string;
  scope_json: string;
  kind: string;
  decision: string;
  expires_at: string | null;
  used_at: string | null;
}

export class PolicyEngine {
  private readonly db: Database;
  private readonly permissions: Record<string, unknown>;
  private readonly denyPatterns: string[];
  private readonly agent: string;
  private readonly requestApproval: (req: ApprovalRequest) => Promise<boolean>;
  private readonly secretValues: () => string[];
  private readonly now: () => Date;
  /** Penolakan per (tool + hash args) dalam satu giliran. */
  private readonly denialCounts = new Map<string, number>();

  constructor(opts: PolicyEngineOptions) {
    this.db = opts.db;
    this.permissions = opts.permissions;
    this.denyPatterns = opts.denyPatterns;
    this.agent = opts.agent;
    this.requestApproval = opts.requestApproval;
    this.secretValues = opts.secretValues;
    this.now = opts.now ?? (() => new Date());
  }

  private hashArgs(call: ToolCall): string {
    const canonical = JSON.stringify({ name: call.name, input: call.input });
    return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  }

  /** Cek lockdown dari database; berlaku setelah restart. */
  isLockdown(): boolean {
    const row = this.db.db
      .prepare("SELECT value FROM app_state WHERE key = 'lockdown'")
      .get() as { value: string } | undefined;
    return row?.value === "1";
  }

  setLockdown(on: boolean): void {
    this.db.db
      .prepare(
        "INSERT INTO app_state (key, value, updated_at) VALUES ('lockdown', ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(on ? "1" : "0", this.now().toISOString());
  }

  /**
   * Putuskan apakah tool boleh jalan.
   * Error apa pun -> deny.
   */
  async authorize(
    call: ToolCall,
    context: ToolContext,
    classification: ToolClassification,
  ): Promise<PolicyDecision> {
    try {
      return await this.decide(call, context, classification);
    } catch (err) {
      const reason =
        err instanceof OmopError ? err.message : `Policy error: ${String(err)}`;
      return { outcome: "deny", effectiveRisk: "high", reason };
    }
  }

  private async decide(
    call: ToolCall,
    context: ToolContext,
    classification: ToolClassification,
  ): Promise<PolicyDecision> {
    // 0. Lockdown: hanya tool baca.
    if (this.isLockdown() && !classification.readOnly) {
      return {
        outcome: "deny",
        effectiveRisk: classification.baseRisk,
        reason: "Mode lockdown aktif. Hanya tool baca yang diizinkan.",
      };
    }

    // 1. Validasi input dasar.
    const inputText = typeof call.input === "string" ? call.input : JSON.stringify(call.input);

    // 2. Unicode tersembunyi dalam perintah shell: tolak.
    if (call.name === "shell" && hasHiddenUnicode(inputText)) {
      return {
        outcome: "deny",
        effectiveRisk: "high",
        reason: "Perintah mengandung Unicode tersembunyi atau bidirectional.",
      };
    }

    // 3. Terlarang.
    if (classification.baseRisk === "forbidden") {
      return {
        outcome: "deny",
        effectiveRisk: "forbidden",
        reason: "Tool ini dilarang.",
      };
    }

    const argsHash = this.hashArgs(call);

    // 4. approvals.deny — pola tolak pengguna, menang atas semua.
    for (const pattern of this.denyPatterns) {
      if (matchesPattern(inputText, pattern)) {
        return {
          outcome: "deny",
          effectiveRisk: classification.baseRisk,
          reason: `Cocok pola tolak: ${pattern}`,
        };
      }
    }

    // 5. permissions dari config.
    const permRule = this.lookupPermission(call.name);

    // 6. Penyesuaian taint.
    const effectiveRisk = applyTaint(classification.baseRisk, context.tainted);

    if (permRule === "deny") {
      return {
        outcome: "deny",
        effectiveRisk,
        reason: `Ditolak oleh aturan permissions untuk "${call.name}".`,
      };
    }

    // 7. Risiko aman -> langsung jalan (kecuali ada permRule deny di atas).
    if (effectiveRisk === "safe" && permRule !== "ask") {
      return { outcome: "allow", effectiveRisk };
    }

    // 8. Risiko sedang/t tinggi: cek izin tersimpan (hanya sedang, non-tainted).
    if (effectiveRisk === "medium" && !context.tainted && permRule !== "ask") {
      const saved = this.findSavedApproval(call.name, argsHash, context);
      if (saved) {
        this.db.db
          .prepare("UPDATE approvals SET used_at = ? WHERE id = ?")
          .run(this.now().toISOString(), saved.id);
        return { outcome: "allow", effectiveRisk, approvalId: saved.id };
      }
    }

    // 9. Anti hammering: 3 penolakan untuk tool+args sama -> hentikan giliran.
    const denialKey = `${call.name}:${argsHash}`;
    const denials = this.denialCounts.get(denialKey) ?? 0;
    if (denials >= 3) {
      return {
        outcome: "deny",
        effectiveRisk,
        reason: "Terlalu banyak penolakan untuk aksi yang sama dalam giliran ini.",
      };
    }

    // 10. Minta approval.
    const request: ApprovalRequest = {
      id: cryptoRandomId(),
      toolName: call.name,
      displayText: this.buildDisplayText(call),
      effectiveRisk: effectiveRisk === "medium" ? "medium" : "high",
      tainted: context.tainted,
      // "selalu" tidak pernah untuk risiko tinggi atau sesi tainted.
      allowAlways: effectiveRisk === "medium" && !context.tainted,
      expiresAt: new Date(this.now().getTime() + 600_000).toISOString(),
    };

    this.db.db
      .prepare(
        "INSERT INTO approvals (id, tool_name, args_hash, scope_json, kind, decision, expires_at, created_at) " +
          "VALUES (?, ?, ?, ?, 'once', 'pending', ?, ?)",
      )
      .run(
        request.id,
        call.name,
        argsHash,
        JSON.stringify({ agent: this.agent, sessionId: context.sessionId }),
        request.expiresAt,
        this.now().toISOString(),
      );

    let approved = false;
    try {
      approved = await this.requestApproval(request);
    } catch {
      approved = false;
    }

    if (!approved) {
      this.db.db
        .prepare("UPDATE approvals SET decision = 'denied', decided_at = ? WHERE id = ?")
        .run(this.now().toISOString(), request.id);
      this.denialCounts.set(denialKey, denials + 1);
      return {
        outcome: "deny",
        effectiveRisk,
        reason: "Ditolak oleh pengguna atau kedaluwarsa.",
      };
    }

    this.db.db
      .prepare("UPDATE approvals SET decision = 'allowed', decided_at = ? WHERE id = ?")
      .run(this.now().toISOString(), request.id);

    return { outcome: "allow", effectiveRisk, approvalId: request.id };
  }

  /** Tampilkan aksi sebenarnya, setelah rahasia disensor. */
  private buildDisplayText(call: ToolCall): string {
    let text: string;
    if (call.name === "shell" && typeof call.input === "object" && call.input !== null) {
      const cmd = (call.input as { command?: unknown }).command;
      text = typeof cmd === "string" ? cmd : JSON.stringify(call.input);
    } else {
      text = JSON.stringify(call.input);
    }
    return redactSecrets(redactValues(text, this.secretValues()));
  }

  private findSavedApproval(
    toolName: string,
    argsHash: string,
    context: ToolContext,
  ): ApprovalRow | undefined {
    const row = this.db.db
      .prepare(
        "SELECT id, tool_name, args_hash, scope_json, kind, decision, expires_at, used_at " +
          "FROM approvals WHERE tool_name = ? AND args_hash = ? AND kind = 'always' " +
          "AND decision = 'allowed' AND (session_id IS NULL OR session_id = ?) " +
          "ORDER BY created_at DESC LIMIT 1",
      )
      .get(toolName, argsHash, context.sessionId) as ApprovalRow | undefined;
    if (!row) return undefined;
    if (row.expires_at && new Date(row.expires_at).getTime() < this.now().getTime()) {
      return undefined;
    }
    return row;
  }

  private lookupPermission(toolName: string): "allow" | "ask" | "deny" | undefined {
    const global = this.permissions[toolName];
    const agentScoped = (this.permissions[this.agent] as Record<string, unknown> | undefined)?.[
      toolName
    ];
    // deny selalu menang.
    if (global === "deny" || agentScoped === "deny") return "deny";
    if (agentScoped === "ask" || global === "ask") return "ask";
    if (agentScoped === "allow" || global === "allow") return "allow";
    return undefined;
  }

  /** Reset penghitung penolakan, dipanggil di awal tiap giliran. */
  resetDenialCounts(): void {
    this.denialCounts.clear();
  }
}

/** Taint menaikkan risiko sedang menjadi tinggi. */
export function applyTaint(base: RiskLevel, tainted: boolean): RiskLevel {
  if (!tainted) return base;
  if (base === "medium") return "high";
  return base;
}

function redactValues(text: string, values: string[]): string {
  let out = text;
  for (const v of values) {
    if (v.length >= 6) out = out.split(v).join("[REDACTED]");
  }
  return out;
}

function matchesPattern(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

function cryptoRandomId(): string {
  return randomId();
}

export function randomId(): string {
  // crypto.randomUUID tersedia di Node 19+.
  return globalThis.crypto.randomUUID();
}
