/**
 * Config Oh My Omop.
 * Lokasi: OMOP_HOME/config.yaml. Rahasia TIDAK boleh ada di file ini —
 * api_key_env hanya nama variabel.
 *
 * Aturan (docs/CONFIG.md):
 * - Kunci tidak dikenal atau nilai tidak valid -> pesan jelas, kode keluar 3.
 * - Harness tidak melanjutkan dengan config yang sebagian rusak.
 * - Rahasia dibaca dari environment lebih dulu, lalu dari secret store.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { OmopError } from "../core/errors.js";

export interface CustomProviderConfig {
  name: string;
  type: "openai-compatible" | "anthropic";
  base_url: string;
  api_key_env?: string;
  headers?: Record<string, string>;
  context_tokens?: number;
  input_per_mtok?: number;
  output_per_mtok?: number;
}

export interface OmopConfig {
  /** Mode operasional: "jb" (zero-refusal, default) atau "strict". */
  mode: "jb" | "strict";
  identity: { personality: string | null };
  model: {
    provider: string;
    name: string;
    effort: string;
    max_tokens: number;
    fallback: { provider: string; name: string }[];
    auxiliary: { provider: string; name: string };
  };
  providers: { custom: CustomProviderConfig[] };
  agent: {
    max_iterations: number;
    max_minutes_per_turn: number;
    max_cost_usd_per_turn: number;
    max_cost_usd_per_day: number;
    max_tool_output_chars: number;
    max_identical_tool_calls: number;
  };
  workspace: { default: string };
  sandbox: {
    backend: "docker" | "local";
    network: "none";
    image: string;
    memory: string;
    cpus: number;
  };
  tls: { ca_file: string | null };
  proxy: { enabled: boolean };
  credentials: { name: string; secret: string; allow_hosts: string[] }[];
  memory: { user_char_limit: number; memory_char_limit: number };
  learning: { review_after_session: boolean };
  habits: { enabled: boolean; max_suggestions_per_day: number; shadow_days: number };
  gateway: {
    telegram: {
      enabled: boolean;
      mode: "polling" | "webhook";
      allow_groups: boolean;
      streaming: "edit" | "off";
      approval_timeout_seconds: number;
      rate_limit_per_minute: number;
    };
  };
  scheduler: { timezone: string };
  notifications: {
    quiet_hours: string;
    max_proactive_per_day: number;
    desktop: boolean;
    daily_report: boolean;
  };
  web_search: { provider: string | null };
  web: { blocklist: string[] };
  mcp: { servers: unknown[] };
  routing: { enabled: boolean };
  voice: { stt_provider: string };
  plugins: { enabled: string[] };
  display: {
    banner: boolean;
    animation: boolean;
    theme: "auto" | "dark" | "light";
    skin: string;
    busy_input: "queue" | "interrupt" | "steer";
    keybinds: Record<string, string>;
    language: "auto" | "id" | "en";
    screen_reader: boolean;
  };
  approvals: { deny: string[] };
  permissions: Record<string, unknown>;
  backup: { remote: string | null };
  update: { check: boolean };
  tools: { by_channel: Record<string, string[]> };
  retention: {
    inbound_updates_days: number;
    checkpoint_days: number;
    inbox_days: number;
  };
}

export const DEFAULT_CONFIG: OmopConfig = {
  identity: { personality: null },
  /**
   * Mode operasional. "jb" = zero-refusal (default Oh My Omop).
   * "strict" = aturan inti saja, tanpa direktif tambahan.
   *
   * Catatan: mode ini hanya mengubah perilaku MODEL terhadap permintaan
   * pemilik. PolicyEngine, sandbox, approval, redaction, taint, dan audit
   * tetap berjalan penuh karena ditegakkan oleh kode, bukan prompt.
   */
  mode: "jb",
  model: {
    provider: "anthropic",
    name: "claude-opus-5-5",
    effort: "high",
    max_tokens: 64000,
    fallback: [],
    auxiliary: { provider: "anthropic", name: "claude-haiku-5-5" },
  },
  providers: { custom: [] },
  agent: {
    max_iterations: 40,
    max_minutes_per_turn: 30,
    max_cost_usd_per_turn: 1.0,
    max_cost_usd_per_day: 5.0,
    max_tool_output_chars: 20000,
    max_identical_tool_calls: 3,
  },
  workspace: { default: "" }, // diisi caller dari defaultWorkspace()
  sandbox: {
    backend: "docker",
    network: "none",
    image: "",
    memory: "2g",
    cpus: 2,
  },
  tls: { ca_file: null },
  proxy: { enabled: false },
  credentials: [],
  memory: { user_char_limit: 1500, memory_char_limit: 2500 },
  learning: { review_after_session: true },
  habits: { enabled: true, max_suggestions_per_day: 1, shadow_days: 7 },
  gateway: {
    telegram: {
      enabled: true,
      mode: "polling",
      allow_groups: false,
      streaming: "edit",
      approval_timeout_seconds: 600,
      rate_limit_per_minute: 20,
    },
  },
  scheduler: { timezone: "Asia/Jakarta" },
  notifications: {
    quiet_hours: "22:00-06:00",
    max_proactive_per_day: 5,
    desktop: false,
    daily_report: false,
  },
  web_search: { provider: null },
  web: { blocklist: [] },
  mcp: { servers: [] },
  routing: { enabled: false },
  voice: { stt_provider: "faster-whisper" },
  plugins: { enabled: [] },
  display: {
    banner: true,
    animation: true,
    theme: "auto",
    skin: "default",
    busy_input: "queue",
    keybinds: {},
    language: "auto",
    screen_reader: false,
  },
  approvals: { deny: [] },
  permissions: {},
  backup: { remote: null },
  update: { check: true },
  tools: { by_channel: {} },
  retention: {
    inbound_updates_days: 7,
    checkpoint_days: 30,
    inbox_days: 7,
  },
};

const KNOWN_TOP_LEVEL = new Set(Object.keys(DEFAULT_CONFIG));

/** Merge default dengan isi file. Kunci tidak dikenal -> error. */
export function mergeConfig(raw: unknown): OmopConfig {
  const cfg: OmopConfig = structuredClone(DEFAULT_CONFIG);
  if (raw === null || raw === undefined) return cfg;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new OmopError("CONFIG_INVALID", "config.yaml harus berupa objek YAML");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      throw new OmopError("CONFIG_INVALID", `Kunci config tidak dikenal: "${key}"`);
    }
  }
  deepMerge(cfg as unknown as Record<string, unknown>, obj);
  return cfg;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const existing = target[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }
    target[key] = value;
  }
}

export function loadConfigFile(path: string): OmopConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OmopError("CONFIG_INVALID", `config.yaml tidak bisa dibaca: ${msg}`);
  }
  return mergeConfig(parsed);
}
