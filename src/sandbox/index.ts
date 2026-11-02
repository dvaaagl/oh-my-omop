/**
 * Sandbox backend (SECURITY.md G5).
 *
 * Docker adalah default:
 *   --network none --cap-drop ALL --security-opt no-new-privileges
 *   --user non-root --memory 2g --cpus 2 --pids-limit 512
 *
 * - Hanya folder workspace yang di-mount. OMOP_HOME dan socket Docker
 *   tidak pernah di-mount.
 * - Environment disaring allowlist.
 * - Kalau Docker tidak tersedia, JANGAN otomatis pindah ke lokal.
 */

import { spawn } from "node:child_process";
import type { ExecRequest, ExecResult } from "../core/types.js";
import { OmopError } from "../core/errors.js";

export interface SandboxBackend {
  readonly kind: "docker" | "local";
  exec(request: ExecRequest, signal: AbortSignal): Promise<ExecResult>;
}

export interface SandboxOptions {
  image: string;
  memory: string;
  cpus: number;
  /** Digest pin opsional. */
  imageDigest?: string;
  dockerPath?: string;
}

/** Environment yang boleh masuk sandbox. */
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "TMPDIR",
  "SHELL",
  "USER",
  "PWD",
  "CI",
  "NODE_ENV",
  "npm_config_cache",
  "npm_config_registry",
]);

export function filterEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (ENV_ALLOWLIST.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}

export class DockerSandbox implements SandboxBackend {
  readonly kind = "docker" as const;

  constructor(private readonly opts: SandboxOptions) {}

  async exec(request: ExecRequest, signal: AbortSignal): Promise<ExecResult> {
    const image = this.opts.imageDigest
      ? `${this.opts.image}@${this.opts.imageDigest}`
      : this.opts.image;
    if (!image) {
      throw new OmopError(
        "NOT_IMPLEMENTED",
        "sandbox.image belum diatur. Set di config.yaml.",
      );
    }

    const args = [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "non-root",
      "--memory",
      this.opts.memory,
      "--cpus",
      String(this.opts.cpus),
      "--pids-limit",
      "512",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=256m",
      "-v",
      `${request.cwd}:/workspace:rw`,
      "-w",
      "/workspace",
      "-e",
      `OMOP_SANDBOX=1`,
      image,
      "/bin/sh",
      "-c",
      request.command,
    ];

    return this.run(this.opts.dockerPath ?? "docker", args, request, signal);
  }

  private run(
    bin: string,
    args: string[],
    request: ExecRequest,
    signal: AbortSignal,
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolvePromise) => {
      const child = spawn(bin, args, {
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let truncated = false;
      let killed = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        child.kill("SIGKILL");
      }, request.timeoutMs);

      const onAbort = (): void => {
        killed = true;
        child.kill("SIGKILL");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > request.maxOutputBytes) {
          stdout = stdout.slice(0, request.maxOutputBytes);
          truncated = true;
          killed = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > request.maxOutputBytes) {
          stderr = stderr.slice(0, request.maxOutputBytes);
          truncated = true;
        }
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolvePromise({
          exitCode: null,
          stdout: truncate(stdout, request.maxOutputBytes),
          stderr: truncate(stderr, request.maxOutputBytes),
          timedOut: false,
          truncated,
        });
        void err;
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolvePromise({
          exitCode: killed && !timedOut && code === null ? null : code,
          stdout: truncate(stdout, request.maxOutputBytes),
          stderr: truncate(stderr, request.maxOutputBytes),
          timedOut,
          truncated,
        });
      });
    });
  }
}

/**
 * Backend lokal. Semua perintah di sini berisiko tinggi (G5).
 * Tidak ada network isolation — dipakai hanya kalau pengguna
 * mengatur sandbox.backend: local secara eksplisit.
 */
export class LocalSandbox implements SandboxBackend {
  readonly kind = "local" as const;

  async exec(request: ExecRequest, signal: AbortSignal): Promise<ExecResult> {
    return new Promise<ExecResult>((resolvePromise) => {
      const child = spawn("/bin/sh", ["-c", request.command], {
        cwd: request.cwd,
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let truncated = false;
      let killed = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        child.kill("SIGKILL");
      }, request.timeoutMs);

      const onAbort = (): void => {
        killed = true;
        child.kill("SIGKILL");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > request.maxOutputBytes) {
          stdout = stdout.slice(0, request.maxOutputBytes);
          truncated = true;
          killed = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > request.maxOutputBytes) {
          stderr = stderr.slice(0, request.maxOutputBytes);
          truncated = true;
        }
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolvePromise({
          exitCode: null,
          stdout: truncate(stdout, request.maxOutputBytes),
          stderr: truncate(stderr, request.maxOutputBytes),
          timedOut: false,
          truncated,
        });
        void err;
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolvePromise({
          exitCode: killed && !timedOut && code === null ? null : code,
          stdout: truncate(stdout, request.maxOutputBytes),
          stderr: truncate(stderr, request.maxOutputBytes),
          timedOut,
          truncated,
        });
      });
    });
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... output dipotong ...]`;
}

/** Cek apakah docker tersedia. */
export async function dockerAvailable(dockerPath = "docker"): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const child = spawn(dockerPath, ["version", "--format", "{{.Server.Version}}"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      res(false);
    }, 8000);
    child.on("error", () => {
      clearTimeout(timer);
      res(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res(code === 0);
    });
  });
}
