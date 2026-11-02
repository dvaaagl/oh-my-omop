/**
 * Notifikasi: jam tenang dan prioritas (FEATURES.md bagian 4).
 *
 * | Prioritas | Contoh | Saat jam tenang |
 * | Mendesak | Approval ditunggu, job gagal 3x | Tetap terkirim |
 * | Normal | Hasil job terjadwal | Dikirim senyap |
 * | Rendah | Saran kebiasaan, usulan tinjauan | Ditunda sampai pagi |
 *
 * Respons atas pesan pengguna tidak terkena aturan ini.
 */

import type { OutboundMessage } from "../core/types.js";

export interface QuietHours {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export interface NotificationPolicyOptions {
  quietHours: QuietHours;
  maxProactivePerDay: number;
  timezone: string;
  now?: () => Date;
}

export type SendDecision =
  | { action: "send" }
  | { action: "defer"; until: Date }
  | { action: "drop"; reason: string };

function parseHm(value: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/** Apakah waktu sekarang berada di dalam jam tenang? */
export function inQuietHours(now: Date, quiet: QuietHours): boolean {
  const start = parseHm(quiet.start);
  const end = parseHm(quiet.end);
  if (!start || !end) return false;

  const cur = now.getHours() * 60 + now.getMinutes();
  const s = start.h * 60 + start.m;
  const e = end.h * 60 + end.m;

  // Jam tenang melewati tengah malam (22:00–06:00).
  if (s > e) return cur >= s || cur < e;
  return cur >= s && cur < e;
}

/** Kapan jam tenang selesai. */
export function quietHoursEnd(now: Date, quiet: QuietHours): Date {
  const end = parseHm(quiet.end);
  if (!end) return now;
  const out = new Date(now.getTime());
  out.setHours(end.h, end.m, 0, 0);
  if (out.getTime() <= now.getTime()) {
    out.setDate(out.getDate() + 1);
  }
  return out;
}

export class NotificationPolicy {
  private readonly opts: NotificationPolicyOptions;
  private readonly now: () => Date;
  private readonly sentToday = new Map<string, number>();

  constructor(opts: NotificationPolicyOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Tentukan apakah pesan proaktif boleh dikirim.
   * Pesan balasan (reaksi terhadap pengguna) selalu dikirim.
   */
  decide(message: OutboundMessage, isReply: boolean): SendDecision {
    if (isReply) return { action: "send" };

    if (message.priority === "urgent") return { action: "send" };

    const now = this.now();
    if (inQuietHours(now, this.opts.quietHours)) {
      if (message.priority === "normal") {
        // Dikirim senyap: tetap kirim, tapi tanpa notifikasi bersuara.
        return { action: "send" };
      }
      return { action: "defer", until: quietHoursEnd(now, this.opts.quietHours) };
    }

    // Batas proaktif per hari.
    const key = now.toISOString().slice(0, 10);
    const count = this.sentToday.get(key) ?? 0;
    if (count >= this.opts.maxProactivePerDay) {
      return { action: "drop", reason: "Batas notifikasi proaktif harian tercapai." };
    }
    this.sentToday.set(key, count + 1);
    return { action: "send" };
  }

  /** Reset hitungan harian (dipakai tes). */
  resetDaily(): void {
    this.sentToday.clear();
  }
}
