/**
 * Error bersama. Semua error harness punya kode stabil supaya
 * bisa diuji dan ditampilkan tanpa bocor detail internal.
 */

export type OmopErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_MISSING_KEY"
  | "SECRET_STORE_LOCKED"
  | "SECRET_NOT_FOUND"
  | "DB_ERROR"
  | "PROVIDER_ERROR"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "POLICY_DENIED"
  | "APPROVAL_TIMEOUT"
  | "TOOL_INPUT_INVALID"
  | "TOOL_ERROR"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PATH_FORBIDDEN"
  | "TAINTED_MEMORY"
  | "LIMIT_REACHED"
  | "NOT_IMPLEMENTED";

export class OmopError extends Error {
  readonly code: OmopErrorCode;
  readonly detail?: string;

  constructor(code: OmopErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "OmopError";
    this.code = code;
    this.detail = detail;
  }
}

/** Bungkus error tak dikenal jadi OmopError tanpa membocorkan isi error. */
export function toOmopError(err: unknown, fallback: OmopErrorCode = "TOOL_ERROR"): OmopError {
  if (err instanceof OmopError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new OmopError(fallback, msg);
}
