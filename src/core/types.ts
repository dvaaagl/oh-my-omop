/**
 * Tipe bersama Oh My Omop.
 * Melengkapi docs/CONTRACTS.md dari dokumentasi rancangan.
 */

// ── Pesan dan model ──────────────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
  /** Respons asli provider, dikirim ulang tanpa perubahan ke provider yang sama. */
  providerRaw?: { provider: string; payload: unknown };
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number; // 0 kalau harga tidak diketahui
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens: number;
  effort?: string;
}

export interface TokenBudget {
  contextTokens: number;
  usedTokens: number;
}

// ── Tool dan policy ──────────────────────────────────────────────

export type RiskLevel = "safe" | "medium" | "high" | "forbidden";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolContext {
  sessionId: string;
  workspace: string;
  origin: "cli" | "telegram" | "scheduler" | "subagent";
  /** Dibaca dari database pada setiap pemeriksaan, bukan dari prompt. */
  tainted: boolean;
  habitId?: string;
  now: () => Date;
  signal: AbortSignal;
}

export type PolicyDecision =
  | { outcome: "allow"; effectiveRisk: RiskLevel; approvalId?: string }
  | { outcome: "deny"; effectiveRisk: RiskLevel; reason: string };

export interface ApprovalRequest {
  id: string;
  toolName: string;
  /** Aksi sebenarnya, setelah rahasia disensor. */
  displayText: string;
  effectiveRisk: "medium" | "high";
  tainted: boolean;
  allowAlways: boolean; // selalu false untuk risiko tinggi dan sesi tainted
  expiresAt: string;
}

export type ApprovalDecision = "allow_once" | "allow_always" | "deny";

// ── Sandbox ──────────────────────────────────────────────────────

export interface ExecRequest {
  command: string;
  cwd: string; // sudah divalidasi berada di dalam workspace
  env: Record<string, string>; // sudah melewati allowlist
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

// ── Kanal ────────────────────────────────────────────────────────

export interface Target {
  channel: string;
  chatId: string;
  threadId?: string;
}

export interface InboundMessage {
  channel: string;
  externalUpdateId: string; // kunci deduplikasi
  senderId: string; // dasar hak akses, Telegram: from.id
  target: Target;
  isPrivate: boolean;
  text: string;
  attachments: { path: string; mimeType: string; bytes: number }[];
  sentAt: string; // waktu asli, untuk pesan saat offline
}

export interface OutboundMessage {
  text: string;
  priority: "urgent" | "normal" | "low";
  documentPath?: string;
}

// ── Ringkasan giliran ────────────────────────────────────────────

export interface TurnSummary {
  sessionId: string;
  stoppedBy: StopReason | "limit" | "cancelled" | "loop";
  toolNames: string[];
  usage: Usage;
  tainted: boolean;
}

// ── Klien agent ──────────────────────────────────────────────────

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_started"; callId: string; name: string; displayText: string }
  | { type: "tool_finished"; callId: string; isError: boolean }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "status"; contextPercent: number; costUsd: number; tainted: boolean }
  | { type: "turn_finished"; summary: TurnSummary };

export interface AgentClient {
  send(sessionKey: string, text: string): AsyncIterable<AgentEvent>;
  respondApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  cancel(sessionKey: string): Promise<void>;
}
