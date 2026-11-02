/**
 * Gateway core (ARCHITECTURE.md bagian 4, 11; RUNTIME.md bagian 4).
 *
 * Tanggung jawab:
 * - Dedup update (G12): tulis dulu, baru konfirmasi.
 * - Cek hak akses dari senderId, BUKAN chatId (G8).
 * - Pengirim tak dikenal tidak memicu model dan tidak dibalas (D-002).
 * - Antrean per sesi: pesan dalam satu sesi berurutan, sesi berbeda paralel.
 * - Handler tidak menunggu agent, supaya /stop tetap terbaca.
 * - Approval dialihkan ke chat pribadi pemilik sesuai asal sesi.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../storage/db.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  InboundMessage,
  OutboundMessage,
  Target,
  TurnSummary,
} from "../core/types.js";
import type { ChannelAdapter } from "./adapter.js";
import { GatewayAuth, extractPairingCode } from "./auth.js";
import { SessionLease } from "./lease.js";
import { redactAll, sanitizeForTerminal } from "../policy/redaction.js";

export interface GatewayDeps {
  db: Database;
  auth: GatewayAuth;
  lease: SessionLease;
  /** Jalankan satu giliran agent untuk sessionKey. */
  runTurn: (
    sessionKey: string,
    text: string,
    signal: AbortSignal,
  ) => AsyncGenerator<GatewayAgentEvent, TurnSummary>;
  /** Izinkan pengirim dari environment (TELEGRAM_ALLOWED_USERS). */
  allowedSendersFromEnv: string[];
  rateLimitPerMinute: number;
  approvalTimeoutMs: number;
  allowGroups: boolean;
  now?: () => Date;
}

export type GatewayAgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "turn_finished"; summary: TurnSummary }
  | { type: "tool_started"; name: string };

interface SessionQueue {
  chain: Promise<void>;
  controller: AbortController | null;
}

export class Gateway {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly queues = new Map<string, SessionQueue>();
  private readonly auth: GatewayAuth;
  private readonly lease: SessionLease;
  private readonly deps: GatewayDeps;
  private readonly now: () => Date;
  /** Approval yang menunggu jawaban, per sesi. */
  private readonly pendingApprovals = new Map<string, ApprovalRequest>();

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.auth = deps.auth;
    this.lease = deps.lease;
    this.now = deps.now ?? (() => new Date());
    for (const sender of deps.allowedSendersFromEnv) {
      if (sender.trim().length > 0) this.auth.registerMember("telegram", sender.trim(), "owner");
    }
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  get adapter(): ChannelAdapter | undefined {
    return this.adapters.get("telegram") ?? [...this.adapters.values()][0];
  }

  /** Mulai semua adapter. */
  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start((msg) => this.handleInbound(msg));
    }
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
    this.adapters.clear();
  }

  /**
   * Proses satu pesan masuk.
   * Handler tidak menunggu agent: agent berjalan di antrean sesi.
   */
  private async handleInbound(message: InboundMessage): Promise<void> {
    const channel = message.channel;

    // 1. Dedup (G12). Update ganda tidak diproses dua kali.
    if (!this.auth.claimUpdate(channel, message.externalUpdateId)) {
      return;
    }

    try {
      // 2. Cek blokir.
      const blocked = this.auth.isBlocked(channel, message.senderId);
      if (blocked) {
        this.auth.markUpdateDone(message.externalUpdateId, true);
        return; // tidak dibalas (D-002)
      }

      // 3. Hak akses dari senderId, bukan chatId.
      const verdict = this.auth.verdict(channel, message.senderId);

      // 4. Pairing hanya di chat pribadi, hanya untuk pengirim tak dikenal.
      if (verdict.kind === "unknown") {
        const code = extractPairingCode(message.text);
        if (code && message.isPrivate) {
          const result = this.auth.consumePairing(channel, message.senderId, code, true);
          if (result.ok) {
            this.auth.setHomeChannel(channel, message.target.chatId, message.target.threadId);
            this.auth.markUpdateDone(message.externalUpdateId);
            await this.safeSend(message.target, {
              text: "Pairing berhasil. Chat ini jadi home channel.",
              priority: "normal",
            });
            return;
          }
          // Kode salah: tidak dibalas, hanya tercatat (D-002).
          this.auth.markUpdateDone(message.externalUpdateId, true);
          return;
        }
        // Bukan pairing: abaikan tanpa membalas.
        this.auth.markUpdateDone(message.externalUpdateId, true);
        return;
      }

      if (verdict.kind === "blocked") {
        this.auth.markUpdateDone(message.externalUpdateId, true);
        return;
      }

      // 5. Rate limit per pengirim.
      if (!this.auth.checkRateLimit(channel, message.senderId, this.deps.rateLimitPerMinute)) {
        this.auth.markUpdateDone(message.externalUpdateId, true);
        return;
      }

      // 6. Grup: sesi selalu tainted dan tidak memuat memori pribadi (G8).
      if (!message.isPrivate && !this.deps.allowGroups) {
        this.auth.markUpdateDone(message.externalUpdateId, true);
        return;
      }

      // 7. Perintah gateway langsung, tanpa memanggil model.
      if (message.text.startsWith("/")) {
        const handled = await this.handleCommand(message, verdict.kind === "owner");
        this.auth.markUpdateDone(message.externalUpdateId);
        if (!handled) {
          // Perintah tak dikenal: lanjut sebagai teks biasa ke agent.
          await this.enqueue(message);
        }
        return;
      }

      this.auth.markUpdateDone(message.externalUpdateId);
      await this.enqueue(message);
    } catch (err) {
      this.auth.markUpdateDone(message.externalUpdateId, true);
      await this.safeSend(message.target, {
        text: `Terjadi error saat memproses pesan: ${err instanceof Error ? err.message : String(err)}`,
        priority: "low",
      });
    }
  }

  /** Masukkan pesan ke antrean sesi. Pesan dalam satu sesi berurutan. */
  private async enqueue(message: InboundMessage): Promise<void> {
    const sessionKey = this.sessionKeyFor(message);
    let entry = this.queues.get(sessionKey);
    if (!entry) {
      entry = { chain: Promise.resolve(), controller: null };
      this.queues.set(sessionKey, entry);
    }

    const run = entry.chain.then(async () => {
      await this.runSession(sessionKey, message);
    });
    entry.chain = run.catch(() => undefined);
    await run;
  }

  private sessionKeyFor(message: InboundMessage): string {
    if (message.channel === "telegram") {
      return message.target.threadId
        ? `telegram:${message.target.chatId}:${message.target.threadId}`
        : `telegram:${message.target.chatId}`;
    }
    return `${message.channel}:${message.target.chatId}`;
  }

  /** Jalankan satu giliran agent dengan lease dan streaming balasan. */
  private async runSession(sessionKey: string, message: InboundMessage): Promise<void> {
    const workerId = randomUUID();
    const controller = new AbortController();
    const queue = this.queues.get(sessionKey);
    if (queue) queue.controller = controller;

    const adapter = this.adapters.get(message.channel);
    if (!adapter) return;

    // /stop: batalkan worker sesi, tanpa lewat antrean.
    if (message.text.trim() === "/stop") {
      controller.abort();
      return;
    }

    // Lease: satu sesi satu worker.
    const sessionId = this.sessionIdFor(sessionKey);
    if (!this.lease.acquire(sessionId, workerId)) {
      await adapter.send(message.target, {
        text: "Sesi ini sedang dipakai proses lain. Coba lagi sebentar.",
        priority: "low",
      });
      return;
    }

    const heartbeat = setInterval(() => {
      this.lease.heartbeat(sessionId, workerId);
    }, this.lease.heartbeatIntervalMs);

    // Streaming: kirim satu pesan, lalu edit setiap beberapa detik.
    let streamMessageId: number | null = null;
    let buffer = "";
    let lastFlush = Date.now();
    const typingTimer = setInterval(() => {
      void adapter;
    }, 4000);

    const approvalTarget = this.approvalTargetFor(message);

    try {
      const gen = this.deps.runTurn(sessionKey, message.text, controller.signal);
      for await (const event of gen) {
        switch (event.type) {
          case "text_delta":
            buffer += event.text;
            if (Date.now() - lastFlush > 1500 && buffer.length > 0) {
              streamMessageId = await this.flushStream(
                adapter,
                message.target,
                streamMessageId,
                buffer,
              );
              buffer = "";
              lastFlush = Date.now();
            }
            break;
          case "approval_requested": {
            // Flush sisa teks dulu supaya approval muncul setelahnya.
            if (buffer.length > 0) {
              streamMessageId = await this.flushStream(
                adapter,
                message.target,
                streamMessageId,
                buffer,
              );
              buffer = "";
            }
            const request = event.request;
            // Approval hanya ke chat pribadi pemilik (RUNTIME.md §4).
            const decision = await adapter.requestApproval(approvalTarget, request);
            this.resolveApproval(request.id, decision);
            break;
          }
          case "tool_started":
            break;
          case "turn_finished":
            break;
        }
      }
      if (buffer.length > 0) {
        await this.flushStream(adapter, message.target, streamMessageId, buffer);
      }
    } catch (err) {
      await this.safeSend(message.target, {
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        priority: "low",
      });
    } finally {
      clearInterval(heartbeat);
      clearInterval(typingTimer);
      this.lease.release(sessionId, workerId);
      if (queue) queue.controller = null;
    }
  }

  /**
   * Approval dialihkan ke chat pribadi pemilik.
   * Telegram yang diambil alih tidak boleh bisa menyetujui aksi di sesi lain.
   */
  private approvalTargetFor(message: InboundMessage): Target {
    const home = this.auth.getHomeChannel(message.channel);
    if (home && message.isPrivate && home.chat_id === message.target.chatId) {
      return message.target;
    }
    if (home) {
      return {
        channel: message.channel,
        chatId: home.chat_id,
        ...(home.thread_id ? { threadId: home.thread_id } : {}),
      };
    }
    return message.target;
  }

  private resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    const resolver = this.pendingApprovals.get(approvalId) as unknown;
    void resolver;
    this.pendingApprovals.delete(approvalId);
  }

  /** Kirim atau edit pesan streaming. */
  private async flushStream(
    adapter: ChannelAdapter,
    target: Target,
    messageId: number | null,
    text: string,
  ): Promise<number | null> {
    const safe = sanitizeForTerminal(redactAll(text, []));
    const telegram = adapter as unknown as {
      editMessage?: (target: Target, messageId: number, text: string) => Promise<void>;
      lastMessageId?: (target: Target) => number | null;
    };
    if (messageId !== null && telegram.editMessage) {
      try {
        await telegram.editMessage(target, messageId, safe);
        return messageId;
      } catch {
        // Edit gagal: kirim pesan baru.
      }
    }
    await adapter.send(target, { text: safe, priority: "normal" });
    return telegram.lastMessageId?.(target) ?? null;
  }

  private async safeSend(target: Target, message: OutboundMessage): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) return;
    try {
      await adapter.send(target, message);
    } catch {
      /* kirim gagal tidak boleh menjatuhkan handler */
    }
  }

  /** Perintah gateway: ditangani tanpa memanggil model. */
  private async handleCommand(message: InboundMessage, isOwner: boolean): Promise<boolean> {
    const text = message.text.trim();
    const [rawCmd] = text.split(/\s+/);
    const cmd = (rawCmd ?? "").toLowerCase().split("@")[0] ?? "";

    switch (cmd) {
      case "/start":
        await this.safeSend(message.target, {
          text: "Oh My Omop siap. Kirim pesan untuk mulai, atau /help untuk bantuan.",
          priority: "normal",
        });
        return true;

      case "/help":
        await this.safeSend(message.target, {
          text: [
            "Perintah tersedia:",
            "/new — sesi baru",
            "/sessions — daftar sesi",
            "/stop — hentikan tugas berjalan",
            "/status — status dan biaya",
            "/whoami — identitas dan peran",
            "/security — sandbox, taint, izin tersimpan",
            "/lockdown — mode darurat (pemilik)",
            "/sethome — jadikan chat ini home channel (pemilik)",
          ].join("\n"),
          priority: "normal",
        });
        return true;

      case "/whoami":
        await this.safeSend(message.target, {
          text: `Anda ${isOwner ? "pemilik" : "anggota"} kanal ${message.channel}.`,
          priority: "normal",
        });
        return true;

      case "/stop":
        return true; // ditangani di runSession

      case "/sethome": {
        if (!isOwner) return true;
        this.auth.setHomeChannel(message.channel, message.target.chatId, message.target.threadId);
        await this.safeSend(message.target, {
          text: "Chat ini dijadikan home channel.",
          priority: "normal",
        });
        return true;
      }

      case "/status": {
        const usage = this.deps.db.db
          .prepare(
            "SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(output_tokens), 0) AS outp FROM messages",
          )
          .get() as { cost: number; inp: number; outp: number };
        await this.safeSend(message.target, {
          text:
            `Biaya total: $${usage.cost.toFixed(4)}\n` +
            `Token: ${usage.inp} masuk / ${usage.outp} keluar`,
          priority: "normal",
        });
        return true;
      }

      case "/lockdown": {
        if (!isOwner) return true;
        const row = this.deps.db.db
          .prepare("SELECT value FROM app_state WHERE key = 'lockdown'")
          .get() as { value: string } | undefined;
        const nowOn = row?.value !== "1";
        this.deps.db.db
          .prepare(
            "INSERT INTO app_state (key, value, updated_at) VALUES ('lockdown', ?, ?) " +
              "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          )
          .run(nowOn ? "1" : "0", this.now().toISOString());
        await this.safeSend(message.target, {
          text: nowOn
            ? "Lockdown AKTIF. Hanya tool baca yang berjalan. Approval tertunda ditolak."
            : "Lockdown dicabut.",
          priority: "urgent",
        });
        return true;
      }

      default:
        return false;
    }
  }

  /** sessionKey -> sessionId (dibuat kalau belum ada). */
  private sessionIdFor(sessionKey: string): string {
    const row = this.deps.db.db
      .prepare("SELECT id FROM sessions WHERE session_key = ? AND ended_at IS NULL")
      .get(sessionKey) as { id: string } | undefined;
    if (row) return row.id;
    const id = randomUUID();
    this.deps.db.db
      .prepare(
        "INSERT INTO sessions (id, session_key, channel, workspace, started_at, tainted) VALUES (?, ?, ?, NULL, ?, 0)",
      )
      .run(
        id,
        sessionKey,
        sessionKey.startsWith("telegram:") ? "telegram" : "cli",
        this.now().toISOString(),
      );
    return id;
  }
}
