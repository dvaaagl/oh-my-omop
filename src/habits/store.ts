/**
 * Kebiasaan: hapus beserta evidence (FLOW.md bagian 10.6, D-009).
 *
 * Menghapus kebiasaan juga menghapus baris `events` yang menjadi
 * evidence-nya dalam satu transaksi, agar tidak terbentuk lagi dari
 * data yang sama. Menghapus `habits` saja tidak cukup, karena cascade
 * hanya menghapus baris penghubung `habit_evidence`.
 */

import type { Database } from "../storage/db.js";

export type HabitKind = "time" | "sequence" | "preference" | "correction";

export type HabitState =
  | "observed"
  | "candidate"
  | "suggested"
  | "active_ask"
  | "shadow"
  | "active_auto"
  | "cooldown"
  | "paused"
  | "stale"
  | "archived";

export interface Habit {
  id: string;
  kind: HabitKind;
  description: string;
  trigger: Record<string, unknown>;
  action: Record<string, unknown>;
  state: HabitState;
  score: number;
  cooldownUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HabitEvidence {
  habitId: string;
  eventId: string;
  weight: number;
}

export class HabitStore {
  constructor(private readonly db: Database) {}

  create(input: {
    kind: HabitKind;
    description: string;
    trigger: Record<string, unknown>;
    action: Record<string, unknown>;
    state?: HabitState;
    score?: number;
  }): Habit {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.db
      .prepare(
        "INSERT INTO habits (id, kind, description, trigger_json, action_json, state, score, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.kind,
        input.description,
        JSON.stringify(input.trigger),
        JSON.stringify(input.action),
        input.state ?? "observed",
        input.score ?? 0,
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): Habit | undefined {
    const row = this.db.db
      .prepare("SELECT * FROM habits WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? toHabit(row) : undefined;
  }

  list(): Habit[] {
    return (
      this.db.db
        .prepare("SELECT * FROM habits ORDER BY score DESC, created_at DESC")
        .all() as Record<string, unknown>[]
    ).map(toHabit);
  }

  setState(id: string, state: HabitState): void {
    this.db.db
      .prepare("UPDATE habits SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, new Date().toISOString(), id);
  }

  setScore(id: string, score: number): void {
    this.db.db
      .prepare("UPDATE habits SET score = ?, updated_at = ? WHERE id = ?")
      .run(score, new Date().toISOString(), id);
  }

  setCooldown(id: string, until: string): void {
    this.db.db
      .prepare("UPDATE habits SET cooldown_until = ?, updated_at = ? WHERE id = ?")
      .run(until, new Date().toISOString(), id);
  }

  /** Tambah evidence; event_id wajib ada di tabel events. */
  addEvidence(habitId: string, eventId: string, weight: number): void {
    this.db.db
      .prepare(
        "INSERT OR REPLACE INTO habit_evidence (habit_id, event_id, weight) VALUES (?, ?, ?)",
      )
      .run(habitId, eventId, weight);
  }

  evidence(habitId: string): HabitEvidence[] {
    return (
      this.db.db
        .prepare("SELECT habit_id, event_id, weight FROM habit_evidence WHERE habit_id = ?")
        .all(habitId) as Record<string, unknown>[]
    ).map((r) => ({
      habitId: String(r.habit_id),
      eventId: String(r.event_id),
      weight: Number(r.weight),
    }));
  }

  /**
   * Hapus kebiasaan beserta SELURUH evidence-nya dalam satu transaksi.
   *
   * Cascade `ON DELETE CASCADE` pada habit_evidence hanya menghapus baris
   * penghubung. Baris `events` yang menjadi evidence harus dihapus
   * eksplisit, kalau tidak kebiasaan yang sama bisa terbentuk lagi dari
   * data yang sama (D-009).
   */
  delete(id: string): { deletedEvents: number } {
    const evidence = this.evidence(id);
    this.db.db.exec("BEGIN IMMEDIATE");
    try {
      const evResult = this.db.db
        .prepare(
          "DELETE FROM events WHERE id IN (SELECT event_id FROM habit_evidence WHERE habit_id = ?)",
        )
        .run(id);
      this.db.db.prepare("DELETE FROM habit_evidence WHERE habit_id = ?").run(id);
      this.db.db.prepare("DELETE FROM habits WHERE id = ?").run(id);
      this.db.db.exec("COMMIT");
      return { deletedEvents: Number(evResult.changes) };
    } catch (err) {
      this.db.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Matikan semua pembelajaran kebiasaan. */
  static readonly ARCHIVED: HabitState = "archived";
}

function toHabit(row: Record<string, unknown>): Habit {
  return {
    id: String(row.id),
    kind: String(row.kind) as HabitKind,
    description: String(row.description),
    trigger: parseJson(row.trigger_json),
    action: parseJson(row.action_json),
    state: String(row.state) as HabitState,
    score: Number(row.score ?? 0),
    cooldownUntil: row.cooldown_until ? String(row.cooldown_until) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Skor kebiasaan (FLOW.md bagian 10.4).
 *   skor = jumlah(bobot_event × 0,5^(umur_hari / 30))
 *
 * | Event | Bobot |
 * | Pola terjadi lagi | +1 |
 * | Saran diterima | +2 |
 * | Saran diabaikan | -0,5 |
 * | Dikoreksi | -2 |
 * | Saran ditolak | -3 |
 *
 * Syarat kandidat: skor minimal 3, muncul di minimal 3 hari berbeda,
 * dan bukan dari data tidak tepercaya. Syarat arsip: skor di bawah 0,5.
 */
export const HABIT_WEIGHTS = {
  pattern_repeat: 1,
  suggestion_accepted: 2,
  suggestion_ignored: -0.5,
  corrected: -2,
  suggestion_rejected: -3,
} as const;

export const HABIT_THRESHOLDS = {
  candidateScore: 3,
  archiveScore: 0.5,
  halfLifeDays: 30,
} as const;

/** Hitung skor dari daftar event dengan umur dalam hari. */
export function computeHabitScore(
  events: { weight: number; ageDays: number }[],
): number {
  let total = 0;
  for (const e of events) {
    total += e.weight * Math.pow(0.5, e.ageDays / HABIT_THRESHOLDS.halfLifeDays);
  }
  return total;
}
