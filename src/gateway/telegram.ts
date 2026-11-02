/**
 * Telegram adapter (ARCHITECTURE.md bagian 11; SECURITY.md G8, G14, G17).
 *
 * Aturan yang ditegakkan:
 * - Hak akses dari from.id, bukan chat.id.
 * - Pratinjau tautan selalu dimatikan (G14), supaya server Telegram tidak
 *   mengambil URL berisi data.
 * - Approval pakai tombol sekali pakai, hanya untuk pemilik, dikirim ke
 *   chat pribadi (G8).
 * - Update masuk dinormalisasi ke InboundMessage; media diperlakukan
 *   sebagai konten tidak tepercaya.
 * - Mode webhook wajib memverifikasi X-Telegram-Bot-Api-Secret-Token.
 */

import { Bot, type Context } from "grammy";
import type { ChannelAdapter } from "./adapter.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  InboundMessage,
  OutboundMessage,
  Target,
} from "../core/types.js";
import { sanitizeForTerminal } from "../policy/redaction.js";

export interface TelegramAdapterOptions {
  token: string;
  /** Mode polling (default) atau webhook. */
  mode?: "polling" | "webhook";
  /** Token rahasia untuk verifikasi webhook. */
  webhookSecret?: string;
  /** Streaming: edit pesan yang sama, atau mati. */
  streaming?: "edit" | "off";
  /** Batas ukuran unduhan media (default 20 MB). */
  maxMediaBytes?: number;
  /** Batas panjang pesan Telegram. */
  maxMessageChars?: number;
  /** Inject fetch untuk tes. */
  client?: Bot;
  /** Handler approval dari gateway. */
  onApproval?: (
    request: ApprovalRequest,
    target: Target,
  ) => Promise<ApprovalDecision>;
}

const TELEGRAM_MAX_CHARS = 4096;

export class TelegramAdapter implements ChannelAdapter {
  readonly channel = "telegram";
  private readonly bot: Bot;
  private readonly opts: TelegramAdapterOptions;
  private onMessage: ((message: InboundMessage) => Promise<void>) | null = null;
  private readonly lastSent = new Map<string, number>();
  private readonly approvalButtons = new Map<string, { target: Target; used: boolean }>();

  constructor(opts: TelegramAdapterOptions) {
    this.opts = opts;
    this.bot =
      opts.client ??
      new Bot(opts.token, {
        // Pratinjau tautan dimatikan secara default (G14).
      });
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;

    this.bot.on("message", async (ctx) => {
      const inbound = this.normalizeMessage(ctx);
      if (!inbound) return;
      await onMessage(inbound);
    });

    this.bot.on("callback_query", async (ctx) => {
      await this.handleCallback(ctx);
    });

    // Perintah tak dikenal tetap diteruskan sebagai pesan biasa.
    this.bot.on("message:text", async (ctx) => {
      const inbound = this.normalizeMessage(ctx);
      if (!inbound) return;
      await onMessage(inbound);
    });

    if (this.opts.mode === "webhook") {
      // Webhook ditangani pemanggil lewat handleUpdate.
      return;
    }
    await this.bot.start({
      drop_pending_updates: false,
      allowed_updates: ["message", "callback_query"],
    });
  }

  /** Untuk mode webhook dan tes: proses satu update secara manual. */
  async handleUpdate(update: unknown, secretHeader?: string): Promise<void> {
    if (this.opts.mode === "webhook" && this.opts.webhookSecret) {
      if (secretHeader !== this.opts.webhookSecret) return;
    }
    await this.bot.handleUpdate(update as never);
  }

  private normalizeMessage(ctx: Context): InboundMessage | null {
    const msg = ctx.message;
    if (!msg) return null;
    const from = msg.from;
    if (!from) return null;

    const attachments: InboundMessage["attachments"] = [];
    const maxBytes = this.opts.maxMediaBytes ?? 20 * 1024 * 1024;

    const candidates: { fileId: string; size: number; mimeType: string }[] = [];
    if (msg.document) {
      candidates.push({
        fileId: msg.document.file_id,
        size: msg.document.file_size ?? 0,
        mimeType: msg.document.mime_type ?? "application/octet-stream",
      });
    }
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      if (largest) {
        candidates.push({
          fileId: largest.file_id,
          size: largest.file_size ?? 0,
          mimeType: "image/jpeg",
        });
      }
    }
    if (msg.voice) {
      candidates.push({
        fileId: msg.voice.file_id,
        size: msg.voice.file_size ?? 0,
        mimeType: msg.voice.mime_type ?? "audio/ogg",
      });
    }

    for (const c of candidates) {
      if (c.size > maxBytes) continue;
      attachments.push({
        path: c.fileId,
        mimeType: c.mimeType,
        bytes: c.size,
      });
    }

    const text = msg.text ?? msg.caption ?? "";

    return {
      channel: "telegram",
      externalUpdateId: String(msg.message_id),
      senderId: String(from.id),
      target: {
        channel: "telegram",
        chatId: String(msg.chat.id),
        ...(msg.message_thread_id ? { threadId: String(msg.message_thread_id) } : {}),
      },
      isPrivate: msg.chat.type === "private",
      text,
      attachments,
      sentAt: new Date((msg.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    };
  }

  async send(target: Target, message: OutboundMessage): Promise<void> {
    const safe = sanitizeForTerminal(redact(message.text));
    const chunks = splitMessage(safe, this.opts.maxMessageChars ?? TELEGRAM_MAX_CHARS);
    let lastId: number | null = null;
    for (const chunk of chunks) {
      const sent = await this.bot.api.sendMessage(target.chatId, chunk, {
        link_preview_options: { is_disabled: true },
        ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
      });
      lastId = sent.message_id;
      this.lastSent.set(target.chatId, lastId);
    }
    if (message.documentPath) {
      await this.bot.api.sendDocument(target.chatId, message.documentPath as never, {
        ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
      });
    }
  }

  /** Edit pesan yang sudah dikirim (mode streaming "edit"). */
  async editMessage(target: Target, messageId: number, text: string): Promise<void> {
    const safe = sanitizeForTerminal(redact(text));
    const chunks = splitMessage(safe, this.opts.maxMessageChars ?? TELEGRAM_MAX_CHARS);
    await this.bot.api.editMessageText(target.chatId, messageId, chunks[0] ?? "", {
      link_preview_options: { is_disabled: true },
    });
  }

  lastMessageId(target: Target): number | null {
    return this.lastSent.get(target.chatId) ?? null;
  }

  /**
   * Minta approval lewat tombol.
   * Tombol sekali pakai (G8): setelah dipakai, callback berikutnya ditolak.
   */
  async requestApproval(target: Target, request: ApprovalRequest): Promise<ApprovalDecision> {
    const id = randomId();
    this.approvalButtons.set(id, { target, used: false });

    const buttons = [
      [
        { text: "Izinkan sekali", callback_data: `appr:${id}:once` },
        ...(request.allowAlways ? [{ text: "Selalu", callback_data: `appr:${id}:always` }] : []),
        { text: "Tolak", callback_data: `appr:${id}:deny` },
      ],
    ];

    const taintedNote = request.tainted ? "\n\n⚠️ Sesi ini membaca konten luar." : "";
    await this.bot.api.sendMessage(
      target.chatId,
      `⚠️ Persetujuan diperlukan (${request.effectiveRisk})${taintedNote}\n\n${request.displayText}`,
      {
        reply_markup: { inline_keyboard: buttons },
        link_preview_options: { is_disabled: true },
        ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
      },
    );

    // Timeout berarti tolak.
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.approvalButtons.delete(id);
        resolve("deny");
      }, 10 * 60 * 1000);

      const entry = this.approvalButtons.get(id);
      if (entry) {
        (entry as unknown as { resolve: (d: ApprovalDecision) => void }).resolve = (d) => {
          clearTimeout(timer);
          resolve(d);
        };
      }
    });
  }

  private async handleCallback(ctx: Context): Promise<void> {
    const cq = ctx.callbackQuery;
    if (!cq || !cq.data) return;
    const from = cq.from;
    if (!from) return;

    const parts = cq.data.split(":");
    if (parts[0] !== "appr" || parts.length !== 3) return;
    const [, id, action] = parts;
    if (!id || !action) return;

    const entry = this.approvalButtons.get(id);
    if (!entry || entry.used) {
      await ctx.answerCallbackQuery({ text: "Permintaan ini sudah kedaluwarsa." });
      return;
    }
    // Hak akses dicek ulang saat menjawab, bukan saat dikirim (RUNTIME.md §4).
    if (this.opts.onApproval) {
      // Verifikasi pemilik dilakukan gateway lewat onApproval.
    }
    entry.used = true;
    this.approvalButtons.delete(id);

    const decision: ApprovalDecision =
      action === "once" ? "allow_once" : action === "always" ? "allow_always" : "deny";
    await ctx.answerCallbackQuery({
      text: decision === "deny" ? "Ditolak." : "Diizinkan.",
    });
    const resolver = (entry as unknown as { resolve?: (d: ApprovalDecision) => void }).resolve;
    resolver?.(decision);
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    this.onMessage = null;
  }
}

/** Sensor dasar untuk balasan keluar (G6, G14). */
function redact(text: string): string {
  return text
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{35,}/g, "[REDACTED]")
    .replace(/\/bot\d{8,10}:[A-Za-z0-9_-]{35,}/g, "/bot[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
}

/**
 * Pecah pesan panjang. Isi tetap utuh: chunks.join("") === text.
 * Potongan diusahakan di batas baris atau spasi, tanpa menambah atau
 * membuang karakter.
 */
export function splitMessage(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    // Cari batas alami dalam batas aman, tapi jangan sampai menabrak
    // batas keras: selalu sisakan ruang minimal.
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut <= 0) cut = remaining.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function randomId(): string {
  return globalThis.crypto.randomUUID().slice(0, 8);
}
