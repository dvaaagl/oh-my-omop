#!/usr/bin/env node
/**
 * Omop CLI.
 * Perintah inti: start, chat, run, doctor, soul, memory, model, secret,
 * skills, review, habits, lockdown.
 */

import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OmopRuntime } from "../runtime.js";
import { sanitizeForTerminal } from "../policy/redaction.js";
import type { AgentEvent } from "../core/types.js";

const BANNER = `
   ____  __  __  ____  __  __
  / __ \\/ / / / |  _ \\|  \\/  |
 | |  | | |_| |  | |_) | |\\/| |   Oh My Omop
 | |  | |  _  |  |  __/| |  | |   agent pribadi dengan SOUL, memori, dan skill
 |_|  |_|_| |_|  |_|   |_|  |_|
`;

interface CliOptions {
  profile?: string;
  noJailbreak?: boolean;
  json?: boolean;
  resume?: boolean;
  workspace?: string;
}

function parseArgs(argv: string[]): { command: string; args: string[]; opts: CliOptions } {
  const opts: CliOptions = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") opts.profile = argv[++i];
    else if (a === "--no-jailbreak" || a === "--strict") opts.noJailbreak = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--resume") opts.resume = true;
    else if (a === "--workspace") opts.workspace = argv[++i];
    else positional.push(a ?? "");
  }
  return { command: positional[0] ?? "help", args: positional.slice(1), opts };
}

function makeRuntime(opts: CliOptions): OmopRuntime {
  const env = { ...process.env };
  if (opts.profile) env.OMOP_PROFILE = opts.profile;
  const runtime = new OmopRuntime({
    env,
    builtinSkillDirs: [join(process.cwd(), "skills")],
    workspace: opts.workspace,
  });
  if (opts.noJailbreak) runtime.jailbreak = false;
  return runtime;
}

async function main(): Promise<void> {
  const { command, args, opts } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "start":
    case "chat":
      await cmdChat(opts, command === "start");
      break;
    case "run":
      await cmdRun(opts, args.join(" "));
      break;
    case "doctor":
      await cmdDoctor(opts);
      break;
    case "soul":
      await cmdSoul(opts, args);
      break;
    case "memory":
      await cmdMemory(opts, args);
      break;
    case "model":
      await cmdModel(opts, args);
      break;
    case "secret":
      await cmdSecret(opts, args);
      break;
    case "skills":
      await cmdSkills(opts, args);
      break;
    case "review":
      await cmdReview(opts, args);
      break;
    case "lockdown":
      await cmdLockdown(opts, args[0] !== "off");
      break;
    case "help":
    default:
      printHelp();
  }
}

function printHelp(): void {
  console.log(BANNER);
  console.log(`Perintah:
  omop chat                  Mulai sesi interaktif
  omop run "<prompt>"        Satu perintah tanpa TUI (aksi approval ditolak)
  omop doctor                Periksa config, provider, dan kanal
  omop soul show|edit|history|rollback
  omop memory list|add|remove
  omop model list|set
  omop secret set|list
  omop skills list|view
  omop review list|approve|reject
  omop lockdown [off]

Opsi:
  --profile <nama>           Pakai profil terpisah
  --strict                   Matikan mode zero-refusal (default: aktif)
  --workspace <path>         Override workspace

Mode zero-refusal (default) mengubah perilaku model terhadap permintaan
pemilik. PolicyEngine, sandbox, approval, dan sensor rahasia tetap aktif.
`);
}

// ── chat ─────────────────────────────────────────────────────────

async function cmdChat(opts: CliOptions, firstRun: boolean): Promise<void> {
  const runtime = makeRuntime(opts);
  console.log(BANNER);
  console.log(
    `Mode: ${runtime.jailbreak ? "zero-refusal (omop-jb)" : "strict"} | Workspace: ${runtime.config.workspace.default}`,
  );
  console.log("Ketik /exit untuk keluar, /jb untuk ganti mode, /soul untuk lihat karakter.\n");

  runtime.approvalHandler = async (req) => {
    const answer = await ask(
      `⚠️  ${req.effectiveRisk.toUpperCase()}${req.tainted ? " (sesi tainted)" : ""}: ${req.displayText}\n   Izinkan? [y]a / [a]lways / [n]tidak: `,
    );
    if (answer.startsWith("a") && req.allowAlways) return "allow_always";
    if (answer.startsWith("y")) return "allow_once";
    return "deny";
  };
  runtime.clarifyHandler = async (q) => ask(`? ${q}\n> `);

  const sessionKey = `cli:${Date.now().toString(36)}`;
  const controller = new AbortController();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.on("SIGINT", () => {
    controller.abort();
    console.log("\n[dibatalkan]");
    rl.close();
    runtime.close();
    process.exit(0);
  });

  while (true) {
    const line = await ask("\nomop> ");
    if (line === null) break;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed === "/exit" || trimmed === "/quit") break;
    if (trimmed === "/jb") {
      runtime.jailbreak = !runtime.jailbreak;
      console.log(
        `[mode: ${runtime.jailbreak ? "zero-refusal (omop-jb)" : "strict"}]`,
      );
      continue;
    }
    if (trimmed === "/soul") {
      const soul = runtime.soul.load();
      console.log(soul.content);
      continue;
    }
    if (trimmed.startsWith("/plan")) {
      runtime.agent = runtime.agent === "plan" ? "build" : "plan";
      console.log(`[agent: ${runtime.agent}]`);
      continue;
    }

    await runAndPrint(runtime, sessionKey, trimmed, controller.signal);
  }

  rl.close();
  runtime.close();
}

async function runAndPrint(
  runtime: OmopRuntime,
  sessionKey: string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const gen = runtime.runTurn(sessionKey, text, signal);
  for await (const event of gen) {
    printEvent(event);
  }
}

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(sanitizeForTerminal(event.text));
      break;
    case "tool_started":
      process.stdout.write(`\n  ⚙ ${event.displayText}\n`);
      break;
    case "tool_finished":
      if (event.isError) process.stdout.write(`  ✗ gagal\n`);
      break;
    case "approval_requested":
      // Ditangani approvalHandler, tidak dicetak di sini.
      break;
    case "status":
      break;
    case "turn_finished": {
      const s = event.summary;
      process.stdout.write(
        `\n\n[${s.stoppedBy} | ${s.usage.inputTokens} in / ${s.usage.outputTokens} out | $${s.usage.costUsd.toFixed(4)}${s.tainted ? " | tainted" : ""}]\n`,
      );
      break;
    }
  }
}

// ── run ──────────────────────────────────────────────────────────

async function cmdRun(opts: CliOptions, prompt: string): Promise<void> {
  if (!prompt) {
    console.error("Prompt kosong. Contoh: omop run \"buat file README\"");
    process.exit(2);
  }
  const runtime = makeRuntime(opts);
  // Aksi yang butuh approval ditolak di mode non-interaktif.
  runtime.approvalHandler = async () => "deny";
  const controller = new AbortController();
  let output = "";
  for await (const event of runtime.runTurn(`cli:run:${Date.now()}`, prompt, controller.signal)) {
    if (event.type === "text_delta") {
      output += event.text;
      process.stdout.write(sanitizeForTerminal(event.text));
    }
    if (event.type === "tool_started") {
      process.stderr.write(`[tool] ${event.displayText}\n`);
    }
  }
  process.stdout.write("\n");
  if (opts.json) {
    console.log(JSON.stringify({ prompt, output }));
  }
  runtime.close();
}

// ── doctor ───────────────────────────────────────────────────────

async function cmdDoctor(opts: CliOptions): Promise<void> {
  const runtime = makeRuntime(opts);
  console.log(BANNER);
  console.log("Oh My Omop doctor\n");

  const checks: { name: string; ok: boolean; detail: string }[] = [];

  // Config.
  checks.push({
    name: "Config",
    ok: true,
    detail: `${runtime.paths.config} (mode: ${runtime.jailbreak ? "jb" : "strict"})`,
  });

  // OMOP_HOME permission.
  const { statSync } = await import("node:fs");
  try {
    const stat = statSync(runtime.paths.home);
    const mode = stat.mode & 0o777;
    const ok = mode === 0o700 || mode === 0o755;
    checks.push({
      name: "Izin OMOP_HOME",
      ok,
      detail: `${runtime.paths.home} mode ${mode.toString(8)}${ok ? "" : " (sebaiknya 0700)"}`,
    });
  } catch {
    checks.push({ name: "Izin OMOP_HOME", ok: false, detail: "tidak bisa dibaca" });
  }

  // Database.
  try {
    const applied = runtime.db.migrate();
    checks.push({
      name: "Database",
      ok: true,
      detail: `${runtime.paths.db} (migrasi baru: ${applied.length === 0 ? "tidak ada" : applied.join(", ")})`,
    });
  } catch (err) {
    checks.push({ name: "Database", ok: false, detail: String(err) });
  }

  // Provider.
  const providers = runtime.providers.list();
  const activeProvider = runtime.config.model.provider;
  const providerOk = providers.includes(activeProvider);
  let providerDetail = `${activeProvider} / ${runtime.config.model.name}`;
  if (providerOk) {
    const keyEnv = providerKeyEnv(activeProvider, runtime.config);
    const hasKey = keyEnv ? runtime.secrets.has(keyEnv) : true;
    providerDetail += hasKey ? " (key ada)" : ` (key ${keyEnv} belum diset)`;
  }
  checks.push({ name: "Provider", ok: providerOk, detail: providerDetail });

  // Sandbox.
  const { dockerAvailable } = await import("../sandbox/index.js");
  if (runtime.config.sandbox.backend === "docker") {
    const hasDocker = await dockerAvailable();
    checks.push({
      name: "Sandbox",
      ok: hasDocker,
      detail: hasDocker
        ? `docker (image: ${runtime.config.sandbox.image || "BELUM DISET"})`
        : "docker tidak tersedia — set sandbox.backend: local kalau memang mau",
    });
  } else {
    checks.push({
      name: "Sandbox",
      ok: true,
      detail: "local (semua perintah shell berisiko tinggi)",
    });
  }

  // Telegram.
  const tgEnabled = runtime.config.gateway.telegram.enabled;
  checks.push({
    name: "Telegram",
    ok: !tgEnabled || runtime.secrets.has("TELEGRAM_BOT_TOKEN"),
    detail: tgEnabled
      ? runtime.secrets.has("TELEGRAM_BOT_TOKEN")
        ? "token tersimpan"
        : "token belum diset (omop secret set TELEGRAM_BOT_TOKEN)"
      : "nonaktif",
  });

  // Audit chain.
  try {
    const rows = runtime.db.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log")
      .get() as { n: number };
    checks.push({
      name: "Audit log",
      ok: true,
      detail: `${rows.n} baris (verifikasi rantai: omop audit verify)`,
    });
  } catch {
    checks.push({ name: "Audit log", ok: false, detail: "tabel tidak ada" });
  }

  // Lockdown.
  checks.push({
    name: "Lockdown",
    ok: !runtime.policy.isLockdown(),
    detail: runtime.policy.isLockdown() ? "AKTIF — hanya tool baca" : "nonaktif",
  });

  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${failed.length === 0 ? "Semua pemeriksaan lolos." : `${failed.length} pemeriksaan perlu perhatian.`}`,
  );
  runtime.close();
}

function providerKeyEnv(provider: string, config: { providers: { custom: { name: string; api_key_env?: string }[] } }): string | undefined {
  const builtin: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };
  if (builtin[provider]) return builtin[provider];
  return config.providers.custom.find((p) => p.name === provider)?.api_key_env;
}

// ── soul ─────────────────────────────────────────────────────────

async function cmdSoul(opts: CliOptions, args: string[]): Promise<void> {
  const runtime = makeRuntime(opts);
  const sub = args[0] ?? "show";
  switch (sub) {
    case "show": {
      const soul = runtime.soul.load();
      console.log(soul.content);
      console.log(`(versi ${soul.version}, sumber ${soul.source})`);
      break;
    }
    case "edit": {
      const path = runtime.paths.soul;
      const { spawnSync } = await import("node:child_process");
      const editor = process.env.EDITOR ?? "nano";
      spawnSync(editor, [path], { stdio: "inherit" });
      const content = await import("node:fs").then((fs) => fs.readFileSync(path, "utf8"));
      const version = runtime.soul.propose(content, "manual edit");
      console.log(`SOUL diperbarui, versi ${version}.`);
      break;
    }
    case "history": {
      for (const h of runtime.soul.history()) {
        console.log(`v${h.version}  ${h.created_at}  ${h.preview.replace(/\n/g, " ")}`);
      }
      break;
    }
    case "rollback": {
      const version = Number(args[1]);
      if (!version) {
        console.error("Butuh nomor versi: omop soul rollback 2");
        process.exit(2);
      }
      const next = runtime.soul.rollback(version);
      console.log(`Dipulihkan ke versi ${version}, disimpan sebagai versi ${next}.`);
      break;
    }
    default:
      console.error("Sub-perintah: show | edit | history | rollback <versi>");
      process.exit(2);
  }
  runtime.close();
}

// ── memory ───────────────────────────────────────────────────────

async function cmdMemory(opts: CliOptions, args: string[]): Promise<void> {
  const runtime = makeRuntime(opts);
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": {
      for (const target of ["user", "memory"] as const) {
        const entries = runtime.memory.list(target);
        console.log(`\n${target === "user" ? "USER.md" : "MEMORY.md"} (${entries.length} entri):`);
        for (const e of entries) console.log(`  - ${e}`);
      }
      break;
    }
    case "add": {
      const target = args[1] as "user" | "memory";
      const text = args.slice(2).join(" ");
      if (target !== "user" && target !== "memory") {
        console.error("Target harus user atau memory.");
        process.exit(2);
      }
      const result = runtime.memory.add(target, text, { tainted: false });
      console.log(result === "saved" ? "Tersimpan." : "Masuk antrean tinjauan.");
      break;
    }
    case "remove": {
      const target = args[1] as "user" | "memory";
      const text = args.slice(2).join(" ");
      runtime.memory.remove(target, text);
      console.log("Dihapus.");
      break;
    }
    default:
      console.error("Sub-perintah: list | add <user|memory> <teks> | remove <user|memory> <teks>");
      process.exit(2);
  }
  runtime.close();
}

// ── model ────────────────────────────────────────────────────────

async function cmdModel(opts: CliOptions, args: string[]): Promise<void> {
  const runtime = makeRuntime(opts);
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": {
      console.log(`Aktif: ${runtime.config.model.provider} / ${runtime.config.model.name}`);
      console.log(`Fallback: ${JSON.stringify(runtime.config.model.fallback)}`);
      console.log(`Pembantu: ${runtime.config.model.auxiliary.provider} / ${runtime.config.model.auxiliary.name}`);
      console.log(`\nProvider tersedia: ${runtime.providers.list().join(", ")}`);
      break;
    }
    case "set": {
      const [provider, model] = args.slice(1);
      if (!provider || !model) {
        console.error("Contoh: omop model set anthropic claude-opus-5-5");
        process.exit(2);
      }
      const configPath = runtime.paths.config;
      const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
      const { parse: py, stringify: sy } = await import("yaml");
      let raw: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        raw = (py(rf(configPath, "utf8")) ?? {}) as Record<string, unknown>;
      }
      raw.model = { ...(raw.model as object), provider, name: model };
      wf(configPath, sy(raw), "utf8");
      console.log(`Model diatur ke ${provider} / ${model}. Berlaku saat proses dimulai ulang.`);
      break;
    }
    default:
      console.error("Sub-perintah: list | set <provider> <model>");
      process.exit(2);
  }
  runtime.close();
}

// ── secret ───────────────────────────────────────────────────────

async function cmdSecret(opts: CliOptions, args: string[]): Promise<void> {
  const runtime = makeRuntime(opts);
  const sub = args[0] ?? "list";
  switch (sub) {
    case "set": {
      const name = args[1];
      if (!name) {
        console.error("Contoh: omop secret set ANTHROPIC_API_KEY");
        process.exit(2);
      }
      const value = await askHidden(`Nilai untuk ${name} (tidak akan tampak): `);
      if (!value) {
        console.error("Nilai kosong, dibatalkan.");
        process.exit(2);
      }
      runtime.secrets.set(name, value);
      console.log(`Secret ${name} tersimpan terenkripsi.`);
      break;
    }
    case "list": {
      const names = runtime.secrets.list();
      console.log(names.length === 0 ? "(belum ada secret)" : names.join("\n"));
      break;
    }
    case "rotate": {
      const master = await askHidden("Master key baru: ");
      if (master.length < 12) {
        console.error("Master key minimal 12 karakter.");
        process.exit(2);
      }
      runtime.secrets.rotate(master);
      console.log("Secret store dienkripsi ulang dengan kunci baru.");
      break;
    }
    default:
      console.error("Sub-perintah: set <NAMA> | list | rotate");
      process.exit(2);
  }
  runtime.close();
}

// ── skills ───────────────────────────────────────────────────────

async function cmdSkills(opts: CliOptions, args: string[]): Promise<void> {
  const runtime = makeRuntime(opts);
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": {
      const entries = runtime.skills.index(runtime.builtinSkillDirs);
      if (entries.length === 0) {
        console.log("(belum ada skill)");
        break;
      }
      for (const e of entries) {
        console.log(`  ${e.name}  [${e.category}/${e.trust}]  ${e.description}`);
      }
      break;
    }
    case "view": {
      const name = args[1];
      if (!name) {
        console.error("Butuh nama skill.");
        process.exit(2);
      }
      const skill = runtime.skills.view(name, runtime.builtinSkillDirs, args[2]);
      console.log(skill.content);
      break;
    }
    default:
      console.error("Sub-perintah: list | view <nama> [file]");
      process.exit(2);
  }
  runtime.close();
}

// ── review ───────────────────────────────────────────────────────

async function cmdReview(opts: CliOptions, args: string[]): Promise<void> {
  const runtime = makeRuntime(opts);
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": {
      const queue = runtime.memory.listQueue();
      if (queue.length === 0) {
        console.log("(antrean kosong)");
        break;
      }
      for (const q of queue) {
        console.log(`  ${q.id}  [${q.target}/${q.operation}]  ${q.content.slice(0, 100)}`);
      }
      break;
    }
    case "approve": {
      runtime.memory.applyApproved(args[1] ?? "");
      console.log("Disetujui dan diterapkan.");
      break;
    }
    case "reject": {
      runtime.memory.rejectProposal(args[1] ?? "");
      console.log("Ditolak.");
      break;
    }
    default:
      console.error("Sub-perintah: list | approve <id> | reject <id>");
      process.exit(2);
  }
  runtime.close();
}

// ── lockdown ─────────────────────────────────────────────────────

async function cmdLockdown(opts: CliOptions, on: boolean): Promise<void> {
  const runtime = makeRuntime(opts);
  runtime.policy.setLockdown(on);
  console.log(on ? "Lockdown AKTIF. Hanya tool baca yang berjalan." : "Lockdown dicabut.");
  runtime.close();
}

// ── helpers ──────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Input tersembunyi tanpa echo. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const { stdin } = process;
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    let value = "";
    const onData = (chunk: Buffer): void => {
      const c = chunk.toString("utf8");
      if (c === "\n" || c === "\r" || c === "\u0004") {
        if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value.trim());
        return;
      }
      if (c === "\u0003") {
        process.exit(130);
      }
      if (c === "\u007f" || c === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += c;
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

void mkdirSync;
void writeFileSync;
void join;

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
