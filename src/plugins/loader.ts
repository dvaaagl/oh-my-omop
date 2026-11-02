/**
 * Plugin dan hook (AGENT.md bagian 6; SECURITY.md G11).
 *
 * - Plugin dimuat dari OMOP_HOME/plugins/<nama>/ hanya jika namanya ada
 *   di plugins.enabled.
 * - Plugin adalah kode dengan hak penuh proses harness.
 * - Tool plugin tetap lewat policy.
 * - Hook hanya boleh MENGAMATI atau MENOLAK; hook tidak bisa memberi izin.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool, ToolRegistry } from "../tools/registry.js";
import type { ModelProvider } from "../providers/types.js";
import type { ToolCall, ToolContext, TurnSummary } from "../core/types.js";

export interface OmopPlugin {
  name: string;
  tools?: Tool[];
  providers?: Record<string, () => ModelProvider>;
  /** Dipanggil sebelum tool dijalankan. Melempar error = tolak tool. */
  beforeTool?(call: ToolCall, context: ToolContext): Promise<void>;
  /** Dipanggil setelah giliran selesai. */
  afterTurn?(turn: TurnSummary): Promise<void>;
}

export interface PluginLoaderOptions {
  pluginsDir: string;
  /** Allowlist dari config. Plugin di luar daftar tidak dimuat. */
  enabled: string[];
  registry: ToolRegistry;
  now?: () => Date;
}

export interface LoadedPlugin {
  name: string;
  plugin: OmopPlugin;
}

export class PluginLoader {
  private readonly opts: PluginLoaderOptions;
  private readonly loaded: LoadedPlugin[] = [];

  constructor(opts: PluginLoaderOptions) {
    this.opts = opts;
  }

  /** Muat plugin yang ada di allowlist. */
  async load(): Promise<{ loaded: string[]; skipped: string[] }> {
    const loaded: string[] = [];
    const skipped: string[] = [];

    if (!existsSync(this.opts.pluginsDir)) {
      return { loaded, skipped: [...this.opts.enabled] };
    }

    const available = new Set<string>();
    try {
      for (const entry of readdirSync(this.opts.pluginsDir)) {
        if (entry.startsWith(".")) continue;
        available.add(entry);
      }
    } catch {
      /* noop */
    }

    for (const name of this.opts.enabled) {
      if (!available.has(name)) {
        skipped.push(`${name} (tidak ada di ${this.opts.pluginsDir})`);
        continue;
      }
      try {
        const entry = join(this.opts.pluginsDir, name, "index.js");
        if (!existsSync(entry)) {
          skipped.push(`${name} (index.js tidak ada)`);
          continue;
        }
        const mod = (await import(pathToFileURL(entry).href)) as {
          default?: OmopPlugin | (() => OmopPlugin | Promise<OmopPlugin>);
        };
        const resolved =
          typeof mod.default === "function"
            ? await (mod.default as () => OmopPlugin | Promise<OmopPlugin>)()
            : mod.default;
        if (!resolved || typeof resolved.name !== "string") {
          skipped.push(`${name} (bentuk ekspor tidak valid)`);
          continue;
        }
        // Tool plugin tetap lewat policy: daftarkan lewat registry biasa.
        if (Array.isArray(resolved.tools)) {
          for (const tool of resolved.tools) {
            try {
              this.opts.registry.register(tool);
            } catch {
              /* tool duplikat: lewati */
            }
          }
        }
        this.loaded.push({ name, plugin: resolved });
        loaded.push(name);
      } catch (err) {
        skipped.push(`${name} (gagal dimuat: ${err instanceof Error ? err.message : String(err)})`);
      }
    }

    return { loaded, skipped };
  }

  /**
   * Jalankan beforeTool semua plugin.
   * Hook hanya boleh mengamati atau menolak: kalau ada hook melempar,
   * tool ditolak. Hook tidak pernah bisa MELULUSKAN tool.
   */
  async runBeforeTool(call: ToolCall, context: ToolContext): Promise<{ allowed: boolean; reason?: string }> {
    for (const { name, plugin } of this.loaded) {
      if (!plugin.beforeTool) continue;
      try {
        await plugin.beforeTool(call, context);
      } catch (err) {
        return {
          allowed: false,
          reason: `Plugin ${name} menolak: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return { allowed: true };
  }

  /** Jalankan afterTurn. Error hook dicatat, tidak menjatuhkan giliran. */
  async runAfterTurn(turn: TurnSummary): Promise<void> {
    for (const { plugin } of this.loaded) {
      if (!plugin.afterTurn) continue;
      try {
        await plugin.afterTurn(turn);
      } catch {
        /* hook pengamat tidak boleh menjatuhkan giliran */
      }
    }
  }

  /** Provider dari plugin. */
  collectProviders(): Record<string, () => ModelProvider> {
    const out: Record<string, () => ModelProvider> = {};
    for (const { plugin } of this.loaded) {
      if (!plugin.providers) continue;
      for (const [name, factory] of Object.entries(plugin.providers)) {
        out[name] = factory;
      }
    }
    return out;
  }

  get loadedNames(): string[] {
    return this.loaded.map((l) => l.name);
  }
}
