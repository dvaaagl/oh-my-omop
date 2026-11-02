/**
 * Tool registry dan validasi input (docs/AGENT.md bagian 4).
 *
 * Tool yang isAvailable-nya false tidak dikirim ke model.
 * Tool baca boleh berjalan paralel; tool lain berjalan berurutan.
 */

import type { JsonSchema } from "./types.js";
import type { RiskLevel, ToolContext } from "../core/types.js";
import { OmopError } from "../core/errors.js";

export interface Tool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  sideEffect: boolean;
  /** Output dibungkus sebagai data tidak tepercaya dan membuat sesi tainted. */
  producesUntrustedContent: boolean;
  classifyRisk(input: Input, context: ToolContext): RiskLevel;
  isAvailable(context: ToolContext): boolean;
  run(input: Input, context: ToolContext): Promise<Output>;
}

export type { JsonSchema };

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new OmopError("TOOL_ERROR", `Tool duplikat: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Tool yang tersedia untuk konteks ini. */
  available(context: ToolContext): Tool[] {
    return [...this.tools.values()].filter((t) => {
      try {
        return t.isAvailable(context);
      } catch {
        return false;
      }
    });
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}

/** Validasi input terhadap schema sederhana (type + required). */
export function validateInput(
  schema: Record<string, unknown>,
  input: unknown,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new OmopError("TOOL_INPUT_INVALID", "Input tool harus berupa objek JSON.");
  }
  const obj = input as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined) {
      throw new OmopError("TOOL_INPUT_INVALID", `Field wajib tidak ada: "${key}".`);
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    const propSchema = properties[key];
    if (!propSchema) continue;
    if (value === undefined || value === null) continue;
    const expected = propSchema.type;
    if (typeof expected !== "string") continue;
    if (!checkType(value, expected)) {
      throw new OmopError(
        "TOOL_INPUT_INVALID",
        `Field "${key}" harus bertipe ${expected}, dapat ${describeType(value)}.`,
      );
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in properties)) {
        throw new OmopError("TOOL_INPUT_INVALID", `Field tidak dikenal: "${key}".`);
      }
    }
  }

  return obj;
}

function checkType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
