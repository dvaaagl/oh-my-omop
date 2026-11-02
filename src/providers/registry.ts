/**
 * Registry provider dan resolver (docs/PROVIDERS.md bagian 2, 3, 6).
 */

import { OmopError } from "../core/errors.js";
import type { OmopConfig } from "../core/config.js";
import type { SecretStore } from "../core/secrets.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { ModelProvider } from "./types.js";

export interface BuiltinProviderDef {
  name: string;
  type: "openai-compatible" | "anthropic";
  baseUrl?: string;
  keyEnv?: string;
  contextTokens?: number;
}

export const BUILTIN_PROVIDERS: BuiltinProviderDef[] = [
  { name: "anthropic", type: "anthropic", contextTokens: 200000 },
  { name: "openai", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", contextTokens: 128000 },
  { name: "openrouter", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", contextTokens: 128000 },
  { name: "ollama", type: "openai-compatible", baseUrl: "http://localhost:11434/v1", contextTokens: 128000 },
  { name: "lmstudio", type: "openai-compatible", baseUrl: "http://localhost:1234/v1", contextTokens: 128000 },
];

export class ProviderRegistry {
  private readonly cache = new Map<string, ModelProvider>();

  constructor(
    private readonly config: OmopConfig,
    private readonly secrets: SecretStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Buat (atau ambil dari cache) provider berdasarkan nama. */
  get(name: string): ModelProvider {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const builtin = BUILTIN_PROVIDERS.find((p) => p.name === name);
    if (builtin) {
      const provider = this.buildFromDef(builtin);
      this.cache.set(name, provider);
      return provider;
    }

    const custom = this.config.providers.custom.find((p) => p.name === name);
    if (custom) {
      this.validateCustom(custom);
      const provider = this.buildFromDef({
        name: custom.name,
        type: custom.type,
        baseUrl: custom.base_url,
        keyEnv: custom.api_key_env,
        contextTokens: custom.context_tokens,
      }, custom.headers, custom.input_per_mtok, custom.output_per_mtok);
      this.cache.set(name, provider);
      return provider;
    }

    throw new OmopError("PROVIDER_ERROR", `Provider "${name}" tidak dikenal.`);
  }

  private validateCustom(custom: { name: string; type: string; base_url: string; headers?: Record<string, string>; api_key_env?: string }): void {
    let url: URL;
    try {
      url = new URL(custom.base_url);
    } catch {
      throw new OmopError("CONFIG_INVALID", `base_url provider "${custom.name}" bukan URL valid.`);
    }
    if (custom.api_key_env && url.protocol === "http:" && !isLocalhost(url.hostname)) {
      throw new OmopError(
        "CONFIG_INVALID",
        `API key hanya boleh dikirim lewat HTTPS, kecuali ke localhost (provider "${custom.name}").`,
      );
    }
    if (custom.headers) {
      for (const value of Object.values(custom.headers)) {
        if (looksLikeSecret(value)) {
          throw new OmopError(
            "CONFIG_INVALID",
            `headers provider "${custom.name}" tidak boleh berisi nilai rahasia. Pakai api_key_env.`,
          );
        }
      }
    }
  }

  private buildFromDef(
    def: BuiltinProviderDef,
    headers?: Record<string, string>,
    inputPerMTok?: number,
    outputPerMTok?: number,
  ): ModelProvider {
    const apiKey = def.keyEnv ? (this.secrets.get(def.keyEnv) ?? undefined) : undefined;
    const requiresKey = def.keyEnv !== undefined;
    if (requiresKey && !apiKey && def.name !== "ollama" && def.name !== "lmstudio") {
      throw new OmopError(
        "PROVIDER_AUTH",
        `API key untuk "${def.name}" belum diatur. Set ${def.keyEnv} di environment atau jalankan \`omop secret set ${def.keyEnv}\`.`,
      );
    }
    if (def.type === "anthropic") {
      return new AnthropicProvider({ apiKey, contextTokens: def.contextTokens, inputPerMTok, outputPerMTok });
    }
    return new OpenAICompatProvider({
      name: def.name,
      baseUrl: def.baseUrl ?? "",
      apiKey,
      headers,
      contextTokens: def.contextTokens,
      inputPerMTok,
      outputPerMTok,
    });
  }

  list(): string[] {
    return [
      ...BUILTIN_PROVIDERS.map((p) => p.name),
      ...this.config.providers.custom.map((p) => p.name),
    ];
  }

  /** Uji koneksi: panggilan streaming minimal. */
  async test(name: string, model: string): Promise<{ ok: boolean; detail: string }> {
    const provider = this.get(name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      let gotText = false;
      for await (const ev of provider.stream(
        {
          model,
          system: "Balas dengan satu kata: ok",
          messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
          tools: [],
          maxTokens: 16,
        },
        controller.signal,
      )) {
        if (ev.type === "text_delta" && ev.text.length > 0) gotText = true;
        if (ev.type === "message") break;
      }
      return { ok: gotText, detail: gotText ? "streaming OK" : "tidak ada teks diterima" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function isLocalhost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".localhost")
  );
}

const SECRET_PATTERNS = [/^sk-[A-Za-z0-9_-]{16,}$/, /^gh[pousr]_[A-Za-z0-9]{16,}$/, /^AKIA[0-9A-Z]{16}$/];

export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(value.trim()));
}
