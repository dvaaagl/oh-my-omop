/**
 * Path dan OMOP_HOME.
 * Semua data pengguna tinggal di OMOP_HOME, default ~/.omop.
 * Profil membuat isolasi penuh: OMOP_HOME/profiles/<nama>/.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface OmopPaths {
  /** Akar data untuk profil aktif. */
  home: string;
  config: string;
  secrets: string;
  secretKey: string;
  db: string;
  gatewayLock: string;
  soul: string;
  personalities: string;
  skins: string;
  memories: string;
  skills: string;
  plugins: string;
  checkpoints: string;
  backups: string;
  inbox: string;
  logs: string;
  plans: string;
  agents: string;
}

export function resolveOmopHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OMOP_HOME?.trim();
  if (raw) {
    if (!isAbsolute(raw)) {
      throw new Error("OMOP_HOME harus path absolut");
    }
    return resolve(raw);
  }
  return join(homedir(), ".omop");
}

export function omopPaths(env: NodeJS.ProcessEnv = process.env): OmopPaths {
  const base = resolveOmopHome(env);
  const profile = env.OMOP_PROFILE?.trim();
  const home = profile ? join(base, "profiles", profile) : base;
  const p = (name: string): string => join(home, name);
  return {
    home,
    config: p("config.yaml"),
    secrets: p("secrets.enc"),
    secretKey: p("secret.key"),
    db: p("state.db"),
    gatewayLock: p("gateway.lock"),
    soul: p("SOUL.md"),
    personalities: p("personalities"),
    skins: p("skins"),
    memories: p("memories"),
    skills: p("skills"),
    plugins: p("plugins"),
    checkpoints: p("checkpoints"),
    backups: p("backups"),
    inbox: p("inbox"),
    logs: p("logs"),
    plans: p("plans"),
    agents: p("agents"),
  };
}

export function defaultWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OMOP_WORKSPACE?.trim();
  if (raw) {
    if (!isAbsolute(raw)) {
      throw new Error("OMOP_WORKSPACE harus path absolut");
    }
    return resolve(raw);
  }
  return join(homedir(), "omop-workspace");
}
