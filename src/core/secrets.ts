/**
 * Secret store terenkripsi (G4).
 * AES-256-GCM. Kunci dari OMOP_MASTER_KEY (hex 64 char) atau file
 * OMOP_HOME/secret.key yang dibuat otomatis dengan izin 0600.
 *
 * Rahasia tidak pernah masuk prompt, log, event, atau pesan error.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { OmopError } from "./errors.js";
import type { OmopPaths } from "./paths.js";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

interface EncryptedFile {
  version: 1;
  secrets: Record<string, { iv: string; tag: string; data: string }>;
}

function emptyStore(): EncryptedFile {
  return { version: 1, secrets: {} };
}

function keyFromMaster(master: string): Buffer {
  const trimmed = master.trim();
  // Terima hex 64 karakter, atau derive dari passphrase apa pun.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  return createHash("sha256").update(trimmed, "utf8").digest();
}

function readKeyFile(paths: OmopPaths, env: NodeJS.ProcessEnv): Buffer {
  const master = env.OMOP_MASTER_KEY?.trim();
  if (master) return keyFromMaster(master);
  if (existsSync(paths.secretKey)) {
    const content = readFileSync(paths.secretKey);
    if (content.length === KEY_BYTES) return content;
    return keyFromMaster(content.toString("utf8"));
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(paths.secretKey, key, { mode: 0o600 });
  try {
    chmodSync(paths.secretKey, 0o600);
  } catch {
    /* platform tanpa chmod */
  }
  return key;
}

export class SecretStore {
  private readonly paths: OmopPaths;
  private readonly env: NodeJS.ProcessEnv;
  private key: Buffer | null = null;
  private store: EncryptedFile | null = null;

  constructor(paths: OmopPaths, env: NodeJS.ProcessEnv = process.env) {
    this.paths = paths;
    this.env = env;
  }

  /** Muat (atau buat) kunci master. */
  private ensureKey(): Buffer {
    if (!this.key) this.key = readKeyFile(this.paths, this.env);
    return this.key;
  }

  private ensureStore(): EncryptedFile {
    if (this.store) return this.store;
    const key = this.ensureKey();
    let store = emptyStore();
    if (existsSync(this.paths.secrets)) {
      try {
        const raw = readFileSync(this.paths.secrets, "utf8");
        // File adalah JSON berisi tiap secret terenkripsi terpisah,
        // sehingga kunci master bisa dirotasi satu per satu.
        store = JSON.parse(raw) as EncryptedFile;
      } catch {
        throw new OmopError(
          "SECRET_STORE_LOCKED",
          "secrets.enc rusak atau kunci master salah. Pulihkan dari backup atau set OMOP_MASTER_KEY yang benar.",
        );
      }
    }
    void key;
    this.store = store;
    return store;
  }

  private encrypt(value: string): { iv: string; tag: string; data: string } {
    const key = this.ensureKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: enc.toString("base64"),
    };
  }

  private decrypt(entry: { iv: string; tag: string; data: string }): string {
    const key = this.ensureKey();
    const decipher = createDecipheriv(ALGO, key, Buffer.from(entry.iv, "base64"));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(entry.data, "base64")),
      decipher.final(),
    ]);
    return dec.toString("utf8");
  }

  private persist(): void {
    if (!this.store) return;
    writeFileSync(this.paths.secrets, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.paths.secrets, 0o600);
    } catch {
      /* noop */
    }
  }

  /** Simpan atau ganti secret. */
  set(name: string, value: string): void {
    const store = this.ensureStore();
    store.secrets[name] = this.encrypt(value);
    this.persist();
  }

  /** Ambil nilai. Environment lebih dulu daripada store. */
  get(name: string): string | null {
    const fromEnv = this.env[name];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    const store = this.ensureStore();
    const entry = store.secrets[name];
    if (!entry) return null;
    try {
      return this.decrypt(entry);
    } catch {
      throw new OmopError(
        "SECRET_STORE_LOCKED",
        `Secret "${name}" tidak bisa didekripsi. OMOP_MASTER_KEY mungkin berubah.`,
      );
    }
  }

  has(name: string): boolean {
    return this.get(name) !== null;
  }

  /** Daftar nama secret, bukan nilainya. */
  list(): string[] {
    return Object.keys(this.ensureStore().secrets).sort();
  }

  remove(name: string): void {
    const store = this.ensureStore();
    delete store.secrets[name];
    this.persist();
  }

  /** Ganti kunci master dan enkripsi ulang semua secret secara atomik. */
  rotate(newMaster: string): void {
    const store = this.ensureStore();
    const plain: Record<string, string> = {};
    for (const [name, entry] of Object.entries(store.secrets)) {
      plain[name] = this.decrypt(entry);
    }
    this.key = keyFromMaster(newMaster);
    const rotated = emptyStore();
    for (const [name, value] of Object.entries(plain)) {
      rotated.secrets[name] = this.encrypt(value);
    }
    this.store = rotated;
    this.persist();
  }
}
