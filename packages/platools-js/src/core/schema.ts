/**
 * Zod → JSON Schema conversion for Platools tools.
 *
 * Strategy:
 *
 *   1. Consumers declare input and output shapes with Zod schemas
 *      (`z.object({...})`, `z.number().int()`, etc.).
 *   2. We hand the schema to `zod-to-json-schema` which does the
 *      heavy lifting — enums, unions, optional fields, nested
 *      objects, `z.literal(...)`, refinements, the lot.
 *   3. The generated schema is post-processed to match the Python
 *      SDK's Pydantic output shape so both SDKs emit equivalent
 *      JSON Schemas over the wire (the platform's tool registry
 *      table stores a single JSON blob and cannot tell which SDK
 *      produced it).
 *
 * This mirrors `platools/core/schema.py` which uses
 * `model.model_json_schema()` under the hood. Silent type drift
 * between the two SDKs is a bug per PRD §5.1.
 */

import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { JsonSchema, ToolOptions } from "../types.js";

/**
 * Raised when a Zod schema cannot be converted to a JSON Schema the
 * platform can accept. Mirrors the Python SDK's `SchemaError`.
 */
export class SchemaError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

/**
 * Internal: strip the mutable wrapper types `zod-to-json-schema`
 * produces and re-cast to our read-only `JsonSchema`. The underlying
 * data is structurally compatible — this is just a type-system cast.
 */
function asJsonSchema(value: unknown): JsonSchema {
  if (value === null || typeof value !== "object") {
    throw new SchemaError("zod-to-json-schema returned a non-object");
  }
  return value as JsonSchema;
}

/**
 * Build the MCP `input_schema` for a tool from its Zod input schema.
 *
 * Raises `SchemaError` if the Zod schema is not an object schema —
 * every tool must take a named-argument object so the platform's
 * LLM routing can address individual fields by name (the same
 * constraint Pydantic enforces on the Python side).
 */
export function buildInputSchema<Input extends z.ZodTypeAny>(
  name: string,
  input: Input,
): JsonSchema {
  const raw = zodToJsonSchema(input, {
    name: `${name}__input`,
    $refStrategy: "root",
    target: "jsonSchema7",
  });
  // zod-to-json-schema with `name` returns `{ $ref, definitions: { [name]: <actual> } }`.
  // Unwrap to the bare schema so the shape matches Pydantic's
  // `model_json_schema()` output (an inline object with `$defs`).
  const unwrapped = unwrapNamedSchema(raw, `${name}__input`);
  const schema = asJsonSchema(unwrapped);
  if (schema.type !== "object") {
    throw new SchemaError(
      `${name}: tool input must be a Zod object schema — got ${String(schema.type)}`,
    );
  }
  // Normalize: drop the `title` Pydantic also trims, drop `$schema`
  // and `additionalProperties: false` if zod-to-json-schema added
  // them (Pydantic doesn't emit either for a basic BaseModel).
  return stripNoiseFields(schema);
}

/**
 * Build the MCP `output_schema` for a tool from its Zod output
 * schema, or return `null` if the consumer declared no output.
 *
 * A Zod output schema is optional in the Python SDK's semantics too
 * — a tool with no typed return value simply has `outputSchema:
 * null` on the wire, and the doctor's `no_return_schema` warning
 * fires.
 */
export function buildOutputSchema<Output extends z.ZodTypeAny>(
  name: string,
  output: Output | undefined,
): JsonSchema | null {
  if (output === undefined) return null;
  const raw = zodToJsonSchema(output, {
    name: `${name}__output`,
    $refStrategy: "root",
    target: "jsonSchema7",
  });
  const unwrapped = unwrapNamedSchema(raw, `${name}__output`);
  return stripNoiseFields(asJsonSchema(unwrapped));
}

/**
 * Top-level convenience — pull both schemas out of a `ToolOptions`
 * in one pass so the decorator doesn't have to thread the tool name
 * through twice.
 */
export function buildSchemas<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
  options: ToolOptions<Input, Output>,
): { inputSchema: JsonSchema; outputSchema: JsonSchema | null } {
  return {
    inputSchema: buildInputSchema(options.name, options.input),
    outputSchema: buildOutputSchema(options.name, options.output),
  };
}

/**
 * Unwrap the `{ $ref, definitions }` envelope `zod-to-json-schema`
 * emits when a `name` is passed. Returns the inline schema with the
 * original definitions promoted to `$defs` so downstream consumers
 * see the Pydantic-compatible shape.
 */
function unwrapNamedSchema(raw: unknown, name: string): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const envelope = raw as {
    $ref?: unknown;
    definitions?: Record<string, unknown>;
    $defs?: Record<string, unknown>;
  };
  const defs = envelope.definitions ?? envelope.$defs;
  if (defs === undefined || typeof defs !== "object") return raw;
  const inner = defs[name];
  if (inner === undefined || typeof inner !== "object") return raw;
  // Pull out every *other* definition — they become $defs on the
  // unwrapped schema so nested models round-trip cleanly.
  const otherDefs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defs)) {
    if (key !== name) otherDefs[key] = value;
  }
  const merged = { ...(inner as Record<string, unknown>) };
  if (Object.keys(otherDefs).length > 0) {
    merged.$defs = { ...((merged.$defs as Record<string, unknown> | undefined) ?? {}), ...otherDefs };
  }
  return merged;
}

/**
 * Drop the handful of fields `zod-to-json-schema` injects that
 * Pydantic doesn't — `$schema`, `title`, and `additionalProperties:
 * false`. Keeping the two SDKs' schemas byte-compatible simplifies
 * the platform's tool registry diffing (PRD §5.1 "silent type drift
 * is a bug").
 */
function stripNoiseFields(schema: JsonSchema): JsonSchema {
  // Structural clone — we're handed a readonly wrapper and must not
  // mutate it in place.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema" || k === "title") continue;
    if (k === "additionalProperties" && v === false) continue;
    out[k] = v;
  }
  return out as JsonSchema;
}
