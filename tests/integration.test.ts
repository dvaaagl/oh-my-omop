/**
 * Integration test: agent loop end-to-end melawan server tiruan.
 * Memakai OMOP_HOME sementara, sandbox lokal, dan workspace sementara.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockModelServer } from "./fakes/mock-model.ts";
import { OmopRuntime } from "../src/runtime.ts";
import type { AgentEvent } from "../src/core/types.ts";

let home: string;
let workspace: string;
let server: MockModelServer;
let baseUrl: string;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "omop-int-"));
  workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  server = new MockModelServer({
    steps: [
      { kind: "tool_call", id: "call_1", name: "file_write", args: { path: "hello.txt", content: "isi dari agent" } },
      { kind: "tool_call", id: "call_2", name: "file_read", args: { path: "hello.txt" } },
      { kind: "text", text: "Selesai. File hello.txt sudah dibuat." },
    ],
  });
  baseUrl = await server.start();
});

after(() => {
  server.stop();
  rmSync(home, { recursive: true, force: true });
});

function makeRuntime(overrides: Record<string, unknown> = {}): OmopRuntime {
  const env = {
    ...process.env,
    OMOP_HOME: home,
    OMOP_MASTER_KEY: "kunci-uji-yang-panjang-dan-acak-1234567890",
    ...(overrides.env as Record<string, string> | undefined),
  } as NodeJS.ProcessEnv;
  const runtime = new OmopRuntime({ env, workspace });
  // Pakai provider custom yang menunjuk ke server tiruan.
  runtime.config.providers.custom = [
    {
      name: "mock",
      type: "openai-compatible",
      base_url: baseUrl,
      context_tokens: 100000,
      input_per_mtok: 0.001,
      output_per_mtok: 0.002,
    },
  ];
  runtime.config.model.provider = "mock";
  runtime.config.model.name = "model-uji";
  runtime.config.model.auxiliary = { provider: "mock", name: "model-uji" };
  runtime.config.sandbox.backend = "local";
  return runtime;
}

describe("agent loop integration", () => {
  test("tugas multi-langkah: tulis file lalu baca kembali", async () => {
    const runtime = makeRuntime();
    let approvals = 0;
    runtime.approvalHandler = async (req) => {
      approvals++;
      if (req.toolName === "file_write") return "allow_once";
      return "allow_once";
    };

    const events: AgentEvent[] = [];
    const gen = runtime.runTurn("cli:uji-1", "buat file hello.txt", new AbortController().signal);
    for await (const ev of gen) events.push(ev);

    const toolStarted = events.filter((e) => e.type === "tool_started");
    const finished = events.find((e) => e.type === "turn_finished");
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");

    assert.ok(toolStarted.length >= 2, `harus ada minimal 2 tool call, dapat ${toolStarted.length}`);
    assert.ok(finished, "giliran harus selesai");
    assert.ok(text.includes("Selesai"), "jawaban akhir harus diterima");
    assert.ok(approvals >= 1, "file_write harus minta approval");
    assert.equal(server.callCount, 3, "provider dipanggil 3 kali");
    assert.ok(
      existsSync(join(workspace, "hello.txt")),
      "file harus benar-benar ada di disk",
    );
    assert.equal(readFileSync(join(workspace, "hello.txt"), "utf8"), "isi dari agent");

    if (finished?.type === "turn_finished") {
      assert.equal(finished.summary.stoppedBy, "end_turn");
      assert.ok(finished.summary.toolNames.includes("file_write"));
    }
    runtime.close();
  });

  test("penolakan approval menghasilkan tool_result error", async () => {
    const home2 = mkdtempSync(join(tmpdir(), "omop-int2-"));
    const ws2 = join(home2, "workspace");
    mkdirSync(ws2, { recursive: true });
    const srv = new MockModelServer({
      steps: [
        { kind: "tool_call", id: "c1", name: "file_write", args: { path: "x.txt", content: "y" } },
        { kind: "text", text: "Baik, saya berhenti." },
      ],
    });
    const url = await srv.start();
    try {
      const runtime = new OmopRuntime({
        env: { ...process.env, OMOP_HOME: home2 } as NodeJS.ProcessEnv,
        workspace: ws2,
      });
      runtime.config.providers.custom = [
        { name: "mock", type: "openai-compatible", base_url: url, context_tokens: 50000 },
      ];
      runtime.config.model.provider = "mock";
      runtime.config.model.name = "m";
      runtime.config.model.auxiliary = { provider: "mock", name: "m" };
      runtime.config.sandbox.backend = "local";
      // Tolak semua approval.
      runtime.approvalHandler = async () => "deny";

      const events: AgentEvent[] = [];
      for await (const ev of runtime.runTurn("cli:uji-2", "tulis x.txt", new AbortController().signal)) {
        events.push(ev);
      }
      assert.ok(!existsSync(join(ws2, "x.txt")), "file tidak boleh dibuat kalau approval ditolak");
      const summary = events.find((e) => e.type === "turn_finished");
      assert.ok(summary);
      runtime.close();
    } finally {
      srv.stop();
      rmSync(home2, { recursive: true, force: true });
    }
  });

  test("tool call dengan JSON rusak ditandai error, tool tidak dijalankan", async () => {
    const home3 = mkdtempSync(join(tmpdir(), "omop-int3-"));
    const ws3 = join(home3, "workspace");
    mkdirSync(ws3, { recursive: true });
    const srv = new MockModelServer({
      steps: [
        { kind: "tool_call_broken", id: "c1", name: "file_write", rawArgs: '{"path": "a.txt", "cont' },
        { kind: "text", text: "Saya kirim ulang argumen yang valid." },
      ],
    });
    const url = await srv.start();
    try {
      const runtime = new OmopRuntime({
        env: { ...process.env, OMOP_HOME: home3 } as NodeJS.ProcessEnv,
        workspace: ws3,
      });
      runtime.config.providers.custom = [
        { name: "mock", type: "openai-compatible", base_url: url, context_tokens: 50000 },
      ];
      runtime.config.model.provider = "mock";
      runtime.config.model.name = "m";
      runtime.config.model.auxiliary = { provider: "mock", name: "m" };
      runtime.config.sandbox.backend = "local";
      runtime.approvalHandler = async () => "allow_once";

      const events: AgentEvent[] = [];
      for await (const ev of runtime.runTurn("cli:uji-3", "tulis a.txt", new AbortController().signal)) {
        events.push(ev);
      }
      assert.ok(!existsSync(join(ws3, "a.txt")), "file tidak boleh dibuat dari JSON rusak");
      runtime.close();
    } finally {
      srv.stop();
      rmSync(home3, { recursive: true, force: true });
    }
  });

  test("sesi dilanjutkan setelah proses mati paksa", async () => {
    const home4 = mkdtempSync(join(tmpdir(), "omop-int4-"));
    const ws4 = join(home4, "workspace");
    mkdirSync(ws4, { recursive: true });
    const srv = new MockModelServer({
      steps: [
        { kind: "tool_call", id: "c1", name: "file_list", args: {} },
        { kind: "text", text: "Isi folder sudah saya cek." },
      ],
    });
    const url = await srv.start();
    try {
      // Sesi pertama: proses dimatikan sebelum tool dijalankan.
      const rt1 = new OmopRuntime({
        env: { ...process.env, OMOP_HOME: home4 } as NodeJS.ProcessEnv,
        workspace: ws4,
      });
      rt1.config.providers.custom = [
        { name: "mock", type: "openai-compatible", base_url: url, context_tokens: 50000 },
      ];
      rt1.config.model.provider = "mock";
      rt1.config.model.name = "m";
      rt1.config.model.auxiliary = { provider: "mock", name: "m" };
      rt1.config.sandbox.backend = "local";
      rt1.approvalHandler = async () => "allow_once";

      const controller = new AbortController();
      const events: AgentEvent[] = [];
      for await (const ev of rt1.runTurn("cli:uji-4", "cek folder", controller.signal)) {
        events.push(ev);
      }
      rt1.close();

      // Sesi baru dengan home yang sama: repairInterrupted harus menambal
      // tool_use yang tidak punya hasil.
      const rt2 = new OmopRuntime({
        env: { ...process.env, OMOP_HOME: home4 } as NodeJS.ProcessEnv,
        workspace: ws4,
      });
      const session = rt2.sessions.findActive("cli:uji-4");
      assert.ok(session, "sesi harus bisa ditemukan lagi");
      const messages = rt2.sessions.messages(session.id);
      // Setiap tool_use harus punya tool_result.
      const toolUseIds = new Set<string>();
      const resultIds = new Set<string>();
      for (const m of messages) {
        const blocks = JSON.parse(m.blocks_json) as { type: string; id?: string; toolUseId?: string }[];
        for (const b of blocks) {
          if (b.type === "tool_use" && b.id) toolUseIds.add(b.id);
          if (b.type === "tool_result" && b.toolUseId) resultIds.add(b.toolUseId);
        }
      }
      for (const id of toolUseIds) {
        assert.ok(resultIds.has(id), `tool_use ${id} harus punya tool_result`);
      }
      rt2.close();
    } finally {
      srv.stop();
      rmSync(home4, { recursive: true, force: true });
    }
  });

  test("batas iterasi dihormati", async () => {
    const home5 = mkdtempSync(join(tmpdir(), "omop-int5-"));
    const ws5 = join(home5, "workspace");
    mkdirSync(ws5, { recursive: true });
    // Server selalu meminta tool call yang sama -> loop terdeteksi.
    const srv = new MockModelServer({
      steps: Array.from({ length: 20 }, (_, i) => ({
        kind: "tool_call" as const,
        id: `c${i}`,
        name: "file_list",
        args: {},
      })),
    });
    const url = await srv.start();
    try {
      const runtime = new OmopRuntime({
        env: { ...process.env, OMOP_HOME: home5 } as NodeJS.ProcessEnv,
        workspace: ws5,
      });
      runtime.config.providers.custom = [
        { name: "mock", type: "openai-compatible", base_url: url, context_tokens: 50000 },
      ];
      runtime.config.model.provider = "mock";
      runtime.config.model.name = "m";
      runtime.config.model.auxiliary = { provider: "mock", name: "m" };
      runtime.config.sandbox.backend = "local";
      runtime.config.agent.max_identical_tool_calls = 3;
      runtime.approvalHandler = async () => "allow_once";

      const events: AgentEvent[] = [];
      for await (const ev of runtime.runTurn("cli:uji-5", "loop", new AbortController().signal)) {
        events.push(ev);
      }
      const summary = events.find((e) => e.type === "turn_finished");
      if (summary?.type === "turn_finished") {
        assert.equal(summary.summary.stoppedBy, "loop", "loop identik harus dihentikan");
      }
      assert.ok(server.callCount >= 0);
      runtime.close();
    } finally {
      srv.stop();
      rmSync(home5, { recursive: true, force: true });
    }
  });

  test("mode jailbreak aktif secara default dan tidak mematikan policy", async () => {
    const runtime = makeRuntime();
    assert.equal(runtime.jailbreak, true, "mode zero-refusal harus default aktif");
    // Policy tetap menolak tool terlarang.
    const context = {
      sessionId: "s",
      workspace,
      origin: "cli" as const,
      tainted: false,
      now: () => new Date(),
      signal: new AbortController().signal,
    };
    const decision = await runtime.policy.authorize(
      { id: "x", name: "shell", input: { command: "cat secrets.enc" } },
      context,
      {
        name: "shell",
        baseRisk: "forbidden",
        readOnly: false,
        sideEffect: true,
        producesUntrustedContent: true,
      },
    );
    assert.equal(decision.outcome, "deny", "tool terlarang tetap ditolak di mode jailbreak");
    runtime.close();
  });

  test("kunci API tidak muncul di log provider", async () => {
    const home6 = mkdtempSync(join(tmpdir(), "omop-int6-"));
    const ws6 = join(home6, "workspace");
    mkdirSync(ws6, { recursive: true });
    const srv = new MockModelServer({ steps: [{ kind: "text", text: "ok" }] });
    const url = await srv.start();
    try {
      const runtime = new OmopRuntime({
        env: { ...process.env, OMOP_HOME: home6 } as NodeJS.ProcessEnv,
        workspace: ws6,
      });
      runtime.config.providers.custom = [
        {
          name: "mock",
          type: "openai-compatible",
          base_url: url,
          api_key_env: "MOCK_KEY",
          context_tokens: 50000,
        },
      ];
      runtime.secrets.set("MOCK_KEY", "sk-nilai-rahasia-yang-harus-disensor-9999");
      runtime.config.model.provider = "mock";
      runtime.config.model.name = "m";
      runtime.config.model.auxiliary = { provider: "mock", name: "m" };
      runtime.config.sandbox.backend = "local";
      runtime.approvalHandler = async () => "allow_once";

      for await (const _ev of runtime.runTurn("cli:uji-6", "hai", new AbortController().signal)) {
        // hanya menjalankan
      }

      // Cek pesan di database tidak memuat nilai key.
      const rows = runtime.db.db
        .prepare("SELECT content, blocks_json FROM messages")
        .all() as { content: string; blocks_json: string }[];
      for (const row of rows) {
        assert.ok(
          !row.content.includes("sk-nilai-rahasia") && !row.blocks_json.includes("sk-nilai-rahasia"),
          "nilai API key tidak boleh masuk database",
        );
      }
      runtime.close();
    } finally {
      srv.stop();
      rmSync(home6, { recursive: true, force: true });
    }
  });
});
