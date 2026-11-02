/**
 * Session lease (RUNTIME.md bagian 3).
 *
 * Satu sesi hanya boleh dijalankan satu worker.
 * - Pemilik memperbarui heartbeat_at setiap 10 detik.
 * - Lease dianggap mati setelah 30 detik tanpa heartbeat.
 * - Setelah lease mati, aksi terputus tidak dijalankan ulang (G12).
 */

import type { Database } from "../storage/db.js";

const HEARTBEAT_INTERVAL_MS = 10_000;
const LEASE_TTL_MS = 30_000;

export class SessionLease {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Ambil lease. Mengembalikan false kalau sesi sedang dipakai worker lain. */
  acquire(sessionId: string, workerId: string): boolean {
    this.reapExpired();
    const existing = this.db.db
      .prepare("SELECT worker_id, heartbeat_at FROM session_leases WHERE session_id = ?")
      .get(sessionId) as { worker_id: string; heartbeat_at: string } | undefined;

    if (existing && existing.worker_id !== workerId) {
      const alive =
        new Date(existing.heartbeat_at).getTime() >
        this.now().getTime() - LEASE_TTL_MS;
      if (alive) return false;
    }

    this.db.db
      .prepare(
        "INSERT INTO session_leases (session_id, worker_id, heartbeat_at, acquired_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET worker_id = excluded.worker_id, heartbeat_at = excluded.heartbeat_at",
      )
      .run(sessionId, workerId, this.now().toISOString(), this.now().toISOString());
    return true;
  }

  heartbeat(sessionId: string, workerId: string): void {
    this.db.db
      .prepare(
        "UPDATE session_leases SET heartbeat_at = ? WHERE session_id = ? AND worker_id = ?",
      )
      .run(this.now().toISOString(), sessionId, workerId);
  }

  release(sessionId: string, workerId: string): void {
    this.db.db
      .prepare("DELETE FROM session_leases WHERE session_id = ? AND worker_id = ?")
      .run(sessionId, workerId);
  }

  /** Lease yang sudah mati dibersihkan. */
  private reapExpired(): void {
    const cutoff = new Date(this.now().getTime() - LEASE_TTL_MS).toISOString();
    this.db.db
      .prepare("DELETE FROM session_leases WHERE heartbeat_at < ?")
      .run(cutoff);
  }

  get heartbeatIntervalMs(): number {
    return HEARTBEAT_INTERVAL_MS;
  }

  get ttlMs(): number {
    return LEASE_TTL_MS;
  }
}
