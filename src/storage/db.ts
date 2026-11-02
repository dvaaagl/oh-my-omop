/**
 * SQLite storage — WAL, foreign key, migrasi.
 * Skema mengikuti FLOW.md bagian 16.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { OmopError } from "../core/errors.js";

interface Migration {
  id: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "core_schema",
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES sessions(id),
  session_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  workspace TEXT,
  prompt_hash TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  tainted INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_active ON sessions(session_key)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  type TEXT NOT NULL,
  action_key TEXT,
  trust TEXT NOT NULL CHECK (trust IN ('trusted', 'untrusted')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS habits (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('time', 'sequence', 'preference', 'correction')),
  description TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'observed', 'candidate', 'suggested', 'active_ask', 'shadow', 'active_auto',
    'cooldown', 'paused', 'stale', 'archived'
  )),
  score REAL NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS habit_evidence (
  habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  weight REAL NOT NULL,
  PRIMARY KEY (habit_id, event_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  habit_id TEXT REFERENCES habits(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('once', 'always')),
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'allowed', 'denied', 'expired')),
  decided_by TEXT,
  decided_at TEXT,
  expires_at TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  habit_id TEXT REFERENCES habits(id) ON DELETE SET NULL,
  schedule TEXT NOT NULL,
  prompt TEXT NOT NULL,
  target_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  misfire TEXT NOT NULL DEFAULT 'skip' CHECK (misfire IN ('run_once', 'skip')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_status TEXT CHECK (last_status IN ('success', 'failed', 'needs_approval')),
  next_run_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS side_effects (
  idempotency_key TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  result_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_updates (
  update_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  sender_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'rejected')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: "audit_log_tamper_chain",
    sql: `
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS soul_versions (
  version INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_queue (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('soul','user','memory','skill','habit')),
  operation TEXT NOT NULL CHECK (operation IN ('add','patch','remove')),
  content TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust IN ('trusted','untrusted')),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
`,
  },
  {
    id: 3,
    name: "gateway_and_leases",
    sql: `
-- Pemilik terdaftar per kanal (SECURITY.md G8).
CREATE TABLE IF NOT EXISTS channel_members (
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel, sender_id)
);

-- Home channel: tujuan balasan proaktif.
CREATE TABLE IF NOT EXISTS home_channels (
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel, chat_id)
);

-- Kode pairing (G8): 128-bit, disimpan sebagai hash, sekali pakai,
-- berlaku 10 menit, hanya dari chat pribadi.
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0
);

-- Pengirim yang diblokir setelah 5 percobaan salah (G8): blokir 1 jam.
CREATE TABLE IF NOT EXISTS blocked_senders (
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  blocked_until TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (channel, sender_id)
);

-- Lease sesi: satu sesi hanya boleh dijalankan satu worker (RUNTIME.md §3).
CREATE TABLE IF NOT EXISTS session_leases (
  session_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);

-- Rate limit per pengirim (G8).
CREATE TABLE IF NOT EXISTS rate_limits (
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, sender_id)
);

-- Deduplikasi update kanal (G12).
CREATE TABLE IF NOT EXISTS inbound_updates_meta (
  update_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'rejected')),
  processed_at TEXT
);

-- Job scheduler (Fase 4).
CREATE TABLE IF NOT EXISTS scheduler_jobs (
  id TEXT PRIMARY KEY,
  session_key TEXT,
  schedule TEXT NOT NULL,
  prompt TEXT NOT NULL,
  target_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  misfire TEXT NOT NULL DEFAULT 'skip' CHECK (misfire IN ('run_once', 'skip')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_status TEXT CHECK (last_status IN ('success', 'failed', 'needs_approval')),
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    id: 4,
    name: "checkpoints",
    sql: `
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS checkpoints_ws_idx ON checkpoints(workspace, created_at);
`,
  },
];

export class Database {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  /** Jalankan migrasi. Aman dijalankan dua kali. */
  migrate(): number[] {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      const row = this.db
        .prepare("SELECT id FROM schema_migrations WHERE id = ?")
        .get(m.id) as { id: number } | undefined;
      if (row) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(m.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)")
          .run(m.id, m.name, new Date().toISOString());
        this.db.exec("COMMIT");
        applied.push(m.id);
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw new OmopError("DB_ERROR", `Migrasi ${m.id} (${m.name}) gagal: ${String(err)}`);
      }
    }
    return applied;
  }

  close(): void {
    this.db.close();
  }
}
