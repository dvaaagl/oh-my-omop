/**
 * Gateway auth, pairing, rate limit, dan dedup (SECURITY.md G8, G12).
 *
 * Aturan yang ditegakkan di sini:
 * - Tolak semua pengirim secara default.
 * - Hak akses dicek dari from.id, BUKAN chat.id.
 * - Pairing memakai kode acak minimal 128 bit, disimpan sebagai hash,
 *   sekali pakai, berlaku 10 menit, hanya di chat pribadi.
 * - Setelah 5 percobaan salah, pengirim diblokir 1 jam.
 * - Pengirim tak dikenal tidak pernah memicu model, tidak memengaruhi
 *   antrean, dan tidak menerima informasi tentang sistem (D-002).
 * - Update ganda tidak diproses dua kali (update_id sebagai kunci).
 */

import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Database } from "../storage/db.js";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const BLOCK_DURATION_MS = 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export type SenderVerdict =
  | { kind: "owner" }
  | { kind: "member" }
  | { kind: "pairing" }
  | { kind: "blocked"; until: string }
  | { kind: "unknown" };

export class GatewayAuth {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Daftarkan pemilik untuk kanal (dipakai pairing dan env TELEGRAM_ALLOWED_USERS). */
  registerMember(channel: string, senderId: string, role: "owner" | "member" = "owner"): void {
    this.db.db
      .prepare(
        "INSERT INTO channel_members (channel, sender_id, role, created_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(channel, sender_id) DO UPDATE SET role = excluded.role",
      )
      .run(channel, senderId, role, this.now().toISOString());
  }

  /** Cabut pengirim terdaftar (omop gateway revoke). */
  revokeMember(channel: string, senderId: string): void {
    this.db.db
      .prepare("DELETE FROM channel_members WHERE channel = ? AND sender_id = ?")
      .run(channel, senderId);
  }

  listMembers(channel: string): { sender_id: string; role: string }[] {
    return this.db.db
      .prepare("SELECT sender_id, role FROM channel_members WHERE channel = ? ORDER BY created_at")
      .all(channel) as { sender_id: string; role: string }[];
  }

  isBlocked(channel: string, senderId: string): string | null {
    const row = this.db.db
      .prepare("SELECT blocked_until FROM blocked_senders WHERE channel = ? AND sender_id = ?")
      .get(channel, senderId) as { blocked_until: string } | undefined;
    if (!row) return null;
    if (new Date(row.blocked_until).getTime() <= this.now().getTime()) {
      this.db.db
        .prepare("DELETE FROM blocked_senders WHERE channel = ? AND sender_id = ?")
        .run(channel, senderId);
      return null;
    }
    return row.blocked_until;
  }

  private block(channel: string, senderId: string, reason: string): void {
    const until = new Date(this.now().getTime() + BLOCK_DURATION_MS).toISOString();
    this.db.db
      .prepare(
        "INSERT INTO blocked_senders (channel, sender_id, blocked_until, reason) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(channel, sender_id) DO UPDATE SET blocked_until = excluded.blocked_until, reason = excluded.reason",
      )
      .run(channel, senderId, until, reason);
  }

  /**
   * Tentukan status pengirim.
   * Hak akses SELALU dari senderId (from.id), bukan chatId.
   */
  verdict(channel: string, senderId: string): SenderVerdict {
    const blocked = this.isBlocked(channel, senderId);
    if (blocked) return { kind: "blocked", until: blocked };
    const row = this.db.db
      .prepare("SELECT role FROM channel_members WHERE channel = ? AND sender_id = ?")
      .get(channel, senderId) as { role: "owner" | "member" } | undefined;
    if (row?.role === "owner") return { kind: "owner" };
    if (row?.role === "member") return { kind: "member" };
    return { kind: "unknown" };
  }

  /** Rate limit per pengirim. Mengembalikan true kalau masih boleh. */
  checkRateLimit(channel: string, senderId: string, perMinute: number): boolean {
    const now = this.now();
    const windowStart = new Date(
      Math.floor(now.getTime() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS,
    ).toISOString();
    const row = this.db.db
      .prepare("SELECT window_start, count FROM rate_limits WHERE channel = ? AND sender_id = ?")
      .get(channel, senderId) as { window_start: string; count: number } | undefined;

    if (!row || row.window_start !== windowStart) {
      this.db.db
        .prepare(
          "INSERT INTO rate_limits (channel, sender_id, window_start, count) VALUES (?, ?, ?, 1) " +
            "ON CONFLICT(channel, sender_id) DO UPDATE SET window_start = excluded.window_start, count = 1",
        )
        .run(channel, senderId, windowStart);
      return perMinute >= 1;
    }

    if (row.count >= perMinute) return false;
    this.db.db
      .prepare("UPDATE rate_limits SET count = count + 1 WHERE channel = ? AND sender_id = ?")
      .run(channel, senderId);
    return true;
  }

  /**
   * Dedup update. Mengembalikan true kalau update BARU (belum pernah diproses).
   * Tulis dulu, baru konfirmasi, supaya aman dari crash (G12).
   */
  claimUpdate(channel: string, updateId: string): boolean {
    const existing = this.db.db
      .prepare("SELECT status FROM inbound_updates_meta WHERE update_id = ?")
      .get(updateId) as { status: string } | undefined;
    if (existing) return false;
    this.db.db
      .prepare(
        "INSERT INTO inbound_updates_meta (update_id, channel, status) VALUES (?, ?, 'pending') " +
          "ON CONFLICT(update_id) DO NOTHING",
      )
      .run(updateId, channel);
    const after = this.db.db
      .prepare("SELECT status FROM inbound_updates_meta WHERE update_id = ?")
      .get(updateId) as { status: string } | undefined;
    return after?.status === "pending";
  }

  markUpdateDone(updateId: string, rejected = false): void {
    this.db.db
      .prepare(
        "UPDATE inbound_updates_meta SET status = ?, processed_at = ? WHERE update_id = ?",
      )
      .run(rejected ? "rejected" : "done", this.now().toISOString(), updateId);
  }

  /**
   * Buat kode pairing baru. Kode dikembalikan ke pemanggil SEKALI,
   * yang disimpan di database hanya hash-nya.
   */
  createPairingCode(channel: string): { code: string; expiresAt: string } {
    // 128 bit acak, basis36, tanpa karakter ambigu.
    const bytes = randomBytes(16);
    const code = alphabetEncode(bytes);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();
    this.db.db
      .prepare(
        "INSERT INTO pairing_codes (code_hash, channel, created_at, expires_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(code_hash) DO UPDATE SET expires_at = excluded.expires_at, created_at = excluded.created_at",
      )
      .run(hashCode(code), channel, now.toISOString(), expiresAt);
    return { code, expiresAt };
  }

  /**
   * Proses pairing. Hanya chat pribadi, kode sekali pakai, berlaku 10 menit.
   * Salah kode: hitungan naik, tidak dibalas. 5 kali salah: blokir 1 jam.
   */
  consumePairing(channel: string, senderId: string, code: string, isPrivate: boolean): {
    ok: boolean;
    reason?: string;
    blocked?: boolean;
  } {
    if (!isPrivate) {
      return { ok: false, reason: "Pairing hanya dari chat pribadi." };
    }
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length === 0) return { ok: false, reason: "Kode kosong." };

    const row = this.db.db
      .prepare("SELECT channel, expires_at, consumed_at, failed_attempts FROM pairing_codes WHERE code_hash = ?")
      .get(hashCode(trimmed)) as
      | { channel: string; expires_at: string; consumed_at: string | null; failed_attempts: number }
      | undefined;

    if (!row) {
      const blocked = this.registerFailedPairing(channel, senderId);
      return { ok: false, reason: "Kode salah.", blocked };
    }
    if (row.consumed_at) {
      const blocked = this.registerFailedPairing(channel, senderId);
      return { ok: false, reason: "Kode sudah dipakai.", blocked };
    }
    if (new Date(row.expires_at).getTime() <= this.now().getTime()) {
      const blocked = this.registerFailedPairing(channel, senderId);
      return { ok: false, reason: "Kode kedaluwarsa.", blocked };
    }
    if (row.channel !== channel) {
      const blocked = this.registerFailedPairing(channel, senderId);
      return { ok: false, reason: "Kode untuk kanal lain.", blocked };
    }

    // Konsumsi sekali pakai: hanya baris pertama yang menang.
    const result = this.db.db
      .prepare(
        "UPDATE pairing_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL",
      )
      .run(this.now().toISOString(), hashCode(trimmed));
    if (result.changes !== 1) {
      return { ok: false, reason: "Kode sudah dipakai." };
    }

    this.registerMember(channel, senderId, "owner");
    return { ok: true };
  }

  private registerFailedPairing(channel: string, senderId: string): boolean {
    const row = this.db.db
      .prepare("SELECT failed_attempts FROM pairing_codes WHERE channel = ?")
      .all(channel) as { failed_attempts: number }[];
    // Hitung total percobaan gagal pengirim ini lewat penanda di blocked_senders
    // sederhana: pakai kolom reason sebagai penghitung tidak praktis, jadi
    // simpan di memori proses + tabel terpisah tidak perlu; cukup pakai
    // tabel blocked_senders dengan reason "attempts:N".
    void row;
    const attemptRow = this.db.db
      .prepare("SELECT reason FROM blocked_senders WHERE channel = ? AND sender_id = ?")
      .get(channel, senderId) as { reason: string } | undefined;
    const attempts = attemptRow?.reason.startsWith("attempts:")
      ? Number(attemptRow.reason.slice("attempts:".length))
      : 0;
    const next = attempts + 1;
    if (next >= MAX_PAIRING_ATTEMPTS) {
      const until = new Date(this.now().getTime() + BLOCK_DURATION_MS).toISOString();
      this.db.db
        .prepare(
          "INSERT INTO blocked_senders (channel, sender_id, blocked_until, reason) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(channel, sender_id) DO UPDATE SET blocked_until = excluded.blocked_until, reason = excluded.reason",
        )
        .run(channel, senderId, until, "pairing_failed");
      return true;
    }
    // Simpan hitungan sementara dengan blocked_until di masa lalu supaya
    // tidak benar-benar memblokir, tapi penghitung tetap ada.
    const past = new Date(this.now().getTime() - 1000).toISOString();
    this.db.db
      .prepare(
        "INSERT INTO blocked_senders (channel, sender_id, blocked_until, reason) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(channel, sender_id) DO UPDATE SET blocked_until = excluded.blocked_until, reason = excluded.reason",
      )
      .run(channel, senderId, past, `attempts:${next}`);
    return false;
  }

  // ── Home channel ───────────────────────────────────────────────

  setHomeChannel(channel: string, chatId: string, threadId?: string): void {
    this.db.db
      .prepare(
        "INSERT INTO home_channels (channel, chat_id, thread_id, created_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(channel, chat_id) DO UPDATE SET thread_id = excluded.thread_id",
      )
      .run(channel, chatId, threadId ?? null, this.now().toISOString());
  }

  getHomeChannel(channel: string): { chat_id: string; thread_id: string | null } | undefined {
    return this.db.db
      .prepare("SELECT chat_id, thread_id FROM home_channels WHERE channel = ? ORDER BY created_at DESC LIMIT 1")
      .get(channel) as { chat_id: string; thread_id: string | null } | undefined;
  }
}

/** Encode 16 byte menjadi 26 karakter, tanpa karakter ambigu. */
function alphabetEncode(bytes: Buffer): string {
  // Alphabet 32 karakter → 5 bit per karakter, 26 karakter = 130 bit ≥ 128 bit.
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  let out = "";
  while (value > 0n) {
    const idx = Number(value % 32n); // alphabet punya 32 karakter
    out = alphabet[idx] + out;
    value = value / 32n;
  }
  // 128 bit → ceil(128/5) = 26 karakter.
  while (out.length < 26) {
    out = alphabet[randomInt(0, alphabet.length)] + out;
  }
  return out.slice(-26);
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Ekstrak kode pairing dari pesan /start. */
export function extractPairingCode(text: string): string | null {
  const m = /^\/start(?:\s+(\S+))?/.exec(text.trim());
  if (!m || !m[1]) return null;
  return m[1];
}
