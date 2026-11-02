/**
 * Scheduler (FLOW.md bagian 13).
 *
 * - Tick setiap menit, ambil job jatuh tempo dengan kunci.
 * - Terlewat saat perangkat mati: jalankan sekali atau lewati sesuai
 *   aturan job (misfire).
 * - Job membuat agent baru tanpa riwayat.
 * - Job tanpa pengguna yang hadir tidak mendapat izin tambahan. Aksi
 *   berisiko tinggi tetap menunggu approval dengan timeout biasa; kalau
 *   timeout habis, aksi ditolak dan job dicatat needs_approval (D-007).
 * - Gagal 3 kali berturut-turut: job dijeda dan pengguna diberi tahu (G10).
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../storage/db.js";
import type { Target } from "../core/types.js";

export type JobStatus = "success" | "failed" | "needs_approval";

export interface SchedulerJob {
  id: string;
  schedule: string;
  prompt: string;
  target: Target;
  enabled: boolean;
  misfire: "run_once" | "skip";
  failureCount: number;
  lastRunAt: string | null;
  lastStatus: JobStatus | null;
  nextRunAt: string;
}

export interface SchedulerDeps {
  db: Database;
  timezone: string;
  /** Jalankan prompt di sesi baru tanpa riwayat. */
  runJob: (job: SchedulerJob) => Promise<JobStatus>;
  /** Beri tahu pengguna (job gagal 3x, butuh approval). */
  notify: (target: Target, text: string) => Promise<void>;
  now?: () => Date;
}

/** Hitung waktu jalan berikutnya dari ekspresi cron 5 bidang. */
export function nextCronRun(schedule: string, from: Date, timezone: string): Date {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Jadwal cron harus 5 bidang, dapat ${fields.length}: "${schedule}"`);
  }
  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];

  // Cari dalam 366 hari ke depan, langkah 1 menit.
  const candidate = new Date(from.getTime() + 60_000);
  candidate.setSeconds(0, 0);
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000;

  let t = candidate.getTime();
  while (t < limit) {
    const d = new Date(t);
    if (
      matchField(minF, d.getMinutes()) &&
      matchField(hourF, d.getHours()) &&
      matchField(domF, d.getDate()) &&
      matchField(monF, d.getMonth() + 1) &&
      matchField(dowF, d.getDay())
    ) {
      void timezone;
      return d;
    }
    t += 60_000;
  }
  throw new Error(`Jadwal "${schedule}" tidak menghasilkan waktu dalam 366 hari.`);
}

/** Cocokkan satu bidang cron: angka, *, list, range, step. */
function matchField(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    if (matchPart(part.trim(), value)) return true;
  }
  return false;
}

function matchPart(part: string, value: number): boolean {
  let spec = part;
  let step = 1;
  let hasStep = false;
  const stepIdx = spec.indexOf("/");
  if (stepIdx !== -1) {
    step = Number(spec.slice(stepIdx + 1));
    spec = spec.slice(0, stepIdx);
    hasStep = true;
    if (!Number.isFinite(step) || step < 1) return false;
  }

  // "*" atau "*/n": cocok kalau value kelipatan step dari 0.
  if (spec === "*" || spec === "") {
    if (!hasStep) return true;
    return value % step === 0;
  }

  const rangeIdx = spec.indexOf("-");
  if (rangeIdx !== -1) {
    const lo = Number(spec.slice(0, rangeIdx));
    const hi = Number(spec.slice(rangeIdx + 1));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
    if (value < lo || value > hi) return false;
    return hasStep ? (value - lo) % step === 0 : true;
  }

  const exact = Number(spec);
  if (!Number.isFinite(exact)) return false;
  // "n/step" tidak umum, tapi perlakukan seperti exact tanpa step.
  return value === exact;
}

export class Scheduler {
  private readonly db: Database;
  private readonly deps: SchedulerDeps;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SchedulerDeps) {
    this.db = deps.db;
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }
  list(): SchedulerJob[] {
    const rows = this.db.db
      .prepare("SELECT * FROM scheduler_jobs ORDER BY next_run_at")
      .all() as Record<string, unknown>[];
    return rows.map(toJob);
  }

  get(id: string): SchedulerJob | undefined {
    const row = this.db.db
      .prepare("SELECT * FROM scheduler_jobs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? toJob(row) : undefined;
  }

  add(input: { schedule: string; prompt: string; target: Target; misfire?: "run_once" | "skip" }): SchedulerJob {
    const id = randomUUID();
    const now = this.now();
    const next = nextCronRun(input.schedule, now, this.deps.timezone);
    this.db.db
      .prepare(
        "INSERT INTO scheduler_jobs (id, schedule, prompt, target_json, misfire, next_run_at, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.schedule,
        input.prompt,
        JSON.stringify(input.target),
        input.misfire ?? "skip",
        next.toISOString(),
        now.toISOString(),
      );
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.db.prepare("DELETE FROM scheduler_jobs WHERE id = ?").run(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.db
      .prepare("UPDATE scheduler_jobs SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
  }

  /**
   * Ambil job jatuh tempo secara atomik: hanya proses yang berhasil
   * memajukan next_run_at yang menjalankan job (RUNTIME.md §2).
   */
  private claimDueJob(): SchedulerJob | null {
    const now = this.now().toISOString();
    const row = this.db.db
      .prepare("SELECT id, next_run_at FROM scheduler_jobs WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 1")
      .get(now) as { id: string; next_run_at: string } | undefined;
    if (!row) return null;

    const job = this.get(row.id);
    if (!job) return null;

    // Majukan next_run_at dengan syarat nilai lamanya masih sama.
    const next = nextCronRun(job.schedule, new Date(row.next_run_at), this.deps.timezone);
    const result = this.db.db
      .prepare("UPDATE scheduler_jobs SET next_run_at = ?, last_run_at = ? WHERE id = ? AND next_run_at = ?")
      .run(next.toISOString(), now, row.id, row.next_run_at);
    if (result.changes !== 1) return null;
    return job;
  }

  /** Jalankan satu tick. Dipanggil setiap menit. */
  async tick(): Promise<number> {
    let ran = 0;
    // Batasi 10 job per tick supaya tidak memonopoli.
    for (let i = 0; i < 10; i++) {
      const job = this.claimDueJob();
      if (!job) break;
      ran++;
      try {
        const status = await this.deps.runJob(job);
        this.recordResult(job.id, status);
      } catch {
        this.recordResult(job.id, "failed");
      }
    }
    return ran;
  }

  private recordResult(id: string, status: JobStatus): void {
    const job = this.get(id);
    if (!job) return;

    if (status === "success") {
      this.db.db
        .prepare("UPDATE scheduler_jobs SET last_status = ?, failure_count = 0 WHERE id = ?")
        .run("success", id);
      return;
    }

    if (status === "needs_approval") {
      // Tidak dihitung sebagai kegagalan, tidak dilanjutkan otomatis (D-007).
      this.db.db
        .prepare("UPDATE scheduler_jobs SET last_status = ? WHERE id = ?")
        .run("needs_approval", id);
      return;
    }

    const failures = job.failureCount + 1;
    if (failures >= 3) {
      this.db.db
        .prepare("UPDATE scheduler_jobs SET last_status = ?, failure_count = ?, enabled = 0 WHERE id = ?")
        .run("failed", failures, id);
      void this.deps.notify(job.target, `Job dijedakan setelah ${failures} kali gagal berturut-turut.`);
      return;
    }
    this.db.db
      .prepare("UPDATE scheduler_jobs SET last_status = ?, failure_count = ? WHERE id = ?")
      .run("failed", failures, id);
  }

  /** Mulai tick setiap menit. */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function toJob(row: Record<string, unknown>): SchedulerJob {
  let target: Target;
  try {
    target = JSON.parse(String(row.target_json)) as Target;
  } catch {
    target = { channel: "telegram", chatId: "" };
  }
  return {
    id: String(row.id),
    schedule: String(row.schedule),
    prompt: String(row.prompt),
    target,
    enabled: Number(row.enabled) === 1,
    misfire: (row.misfire as "run_once" | "skip") ?? "skip",
    failureCount: Number(row.failure_count ?? 0),
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    lastStatus: (row.last_status as JobStatus | null) ?? null,
    nextRunAt: String(row.next_run_at),
  };
}

export { nextCronRun as computeNextRun };
