/**
 * Tool shell — jalan di sandbox, selalu lewat policy.
 * Klasifikasi risiko mengikuti SECURITY.md G3 dan policy/classifier.ts.
 */

import type { Tool, ToolRegistry } from "./registry.js";
import { validateInput } from "./registry.js";
import type { RiskLevel, ToolContext } from "../core/types.js";
import { classifyShell } from "../policy/classifier.js";
import { wrapUntrusted } from "../policy/redaction.js";
import type { SandboxBackend } from "../sandbox/index.js";
import { filterEnv } from "../sandbox/index.js";

export interface ShellToolOptions {
  sandbox: SandboxBackend;
  defaultTimeoutMs?: number;
}

export function shellTool(opts: ShellToolOptions): Tool {
  const defaultTimeout = opts.defaultTimeoutMs ?? 120_000;
  return {
    name: "shell",
    description:
      "Jalankan perintah shell di sandbox terisolasi. Perintah baca umum (ls, git status) langsung jalan; lainnya butuh persetujuan. Output diperlakukan sebagai data.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Perintah yang dijalankan." },
        timeout_ms: { type: "integer", description: "Timeout, maksimum 600000." },
      },
      required: ["command"],
    },
    readOnly: false,
    sideEffect: true,
    producesUntrustedContent: true,
    classifyRisk: (input): RiskLevel => {
      const command = (input as { command?: string }).command ?? "";
      return classifyShell(command, opts.sandbox.kind).risk;
    },
    isAvailable: (): boolean => true,
    async run(input, context) {
      const args = validateInput(this.inputSchema, input) as {
        command: string;
        timeout_ms?: number;
      };
      const timeout = Math.min(args.timeout_ms ?? defaultTimeout, 600_000);
      const result = await opts.sandbox.exec(
        {
          command: args.command,
          cwd: context.workspace,
          env: filterEnv(process.env),
          timeoutMs: timeout,
          maxOutputBytes: 200_000,
        },
        context.signal,
      );
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        stdout: wrapUntrusted("shell:stdout", result.stdout),
        stderr: wrapUntrusted("shell:stderr", result.stderr),
      };
    },
  };
}

export function registerShellTool(registry: ToolRegistry, opts: ShellToolOptions): void {
  registry.register(shellTool(opts));
}
