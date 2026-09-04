// `Tool` — an immutable, content-addressed schema version.
//
// A `Tool` row is NOT "a tool an entity has". It is one version of one tool's
// shape, keyed `@@unique([name, schemaHash])`, and it is never updated: the
// source's `tx.tool.upsert` passes `update: {}`, so a second registration of an
// identical shape finds the existing row and a changed shape mints a new one.
// The mutable "who exposes what, where, and is it on" state lives entirely in
// `EnvironmentEntityTool` (see `domain/exposure.ts`).
//
// THAT SPLIT IS WHAT MAKES THE REGISTRY SAFE TO REBUILD. Historical versions
// accumulate in `Tool` and are harmless, because nothing dispatches to a `Tool`
// — it dispatches to an exposure, and a registration replaces an entity's
// complete exposure set. The registry can therefore SHRINK, which the source's
// own note calls out as the property a rebuild that only ever grows does not
// have.
//
// THE HASH IS COMPUTED IN TWO HALVES AND ONLY ONE OF THEM IS HERE. Canonicalising
// the document is a domain rule — which fields participate, in what order, with
// what treatment of `undefined` — and it is transcribed exactly. Taking a digest
// of that string is not: it is a primitive this layer may not import (ADR M0.3
// §2), so `application/ports/content-digest.ts` states it as a port. What comes
// back is truncated here, because the truncation is also a domain rule.

import { err, ok, type Result } from "@platos/kernel";

import { declarationInvalid } from "./errors.js";
import { asToolsIdentifier, type SchemaHash, type ToolId, type ToolName } from "./identifiers.js";

/**
 * `Tool.kind`. Transcribed from the `ToolKind` enum.
 *
 *   ENTITY   registered by a customer backend over the wire or by MCP discovery.
 *   RUNTIME  supplied by the platform to a turn.
 *   META     a tool about tools — `find_tools` and its siblings.
 *
 * Registration mints `ENTITY` and only `ENTITY`; the other two exist so a
 * runtime or meta tool can share the `Tool` row shape without being
 * dispatchable to an entity backend.
 */
export const TOOL_KINDS = ["ENTITY", "RUNTIME", "META"] as const;

export type ToolKind = (typeof TOOL_KINDS)[number];

/** Ceiling on a declared tool name. */
export const MAX_TOOL_NAME_LENGTH = 200;

/** Ceiling on a declared description. Generous: it is a model's only briefing. */
export const MAX_TOOL_DESCRIPTION_LENGTH = 8_192;

/**
 * How much of the digest becomes the `schemaHash`.
 *
 * Sixteen hex characters — 64 bits, transcribed. It is a version discriminator
 * and not a security boundary: a collision would merge two shapes under one
 * row, which the `@@unique([name, schemaHash])` key would then make invisible,
 * so the width is recorded here with its reason rather than left as a `.slice`
 * in the middle of a service method.
 */
export const SCHEMA_HASH_LENGTH = 16;

export interface Tool {
  readonly toolId: ToolId;
  readonly name: ToolName;
  readonly description: string;
  readonly kind: ToolKind;
  /** A JSON Schema object. Opaque here; validated where a call is admitted. */
  readonly paramSchema: Readonly<Record<string, unknown>>;
  readonly category: string;
  readonly schemaHash: SchemaHash;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The canonical string a tool's schema hash is taken over.
 *
 * Key order is sorted at every level and the four participating fields are
 * emitted in a fixed order, so two structurally identical declarations that
 * arrived with differently-ordered JSON keys hash the same and are one version.
 * Without this the registry would mint a fresh `Tool` row on every restart of a
 * backend whose serialiser happens not to be stable.
 *
 * `undefined` becomes `null`, matching the source's `JSON.stringify(value) ??
 * "null"` fallback: a field explicitly present-and-undefined and a field that
 * round-tripped through JSON must not hash differently.
 */
export function canonicalToolDocument(input: {
  readonly name: string;
  readonly description: string;
  readonly paramSchema: unknown;
  readonly category: string;
}): string {
  return stableJson({
    name: input.name,
    description: input.description,
    paramSchema: input.paramSchema,
    category: input.category,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Narrow a full digest to a `schemaHash`.
 *
 * Refuses a digest that is not lowercase hexadecimal or is shorter than the
 * width it must yield. A silently-truncated non-hex digest would still produce
 * a plausible-looking key, and every row minted under it would be wrong in a
 * way nothing downstream could detect.
 */
export function toSchemaHash(digest: string): Result<SchemaHash> {
  if (!/^[0-9a-f]+$/u.test(digest) || digest.length < SCHEMA_HASH_LENGTH) {
    return err(
      declarationInvalid(`a schema digest must be at least ${SCHEMA_HASH_LENGTH} lowercase hex characters`, [
        { field: "schemaHash", code: "invalid", message: "digest is not usable" },
      ]),
    );
  }
  return ok(asToolsIdentifier<SchemaHash>(digest.slice(0, SCHEMA_HASH_LENGTH)));
}

/**
 * The category a tool falls into when its author did not say.
 *
 * Transcribed from `inferEntityToolCategory`: the segment before the first dot
 * of a dotted name, else the entity's own external id, else the literal
 * `entity`. The dotted-prefix rule is what makes `github.create_issue` and
 * `github.list_repos` group together even when two different entities
 * registered them.
 */
export function inferToolCategory(toolName: string, externalEntityId: string): string {
  const name = toolName.trim();
  const dot = name.indexOf(".");
  if (dot > 0) {
    const prefix = name.slice(0, dot).trim();
    if (prefix !== "") return prefix;
  }
  return externalEntityId.trim() === "" ? "entity" : externalEntityId.trim();
}

/**
 * The text a tool is INDEXED by, and the reason discovery works at all.
 *
 * Name, description and the sorted parameter names. Parameter names earn their
 * place: a model searching for "upload a file by path" finds a tool whose
 * description never says "path" but whose schema does.
 */
export function searchDocument(tool: {
  readonly name: string;
  readonly description: string;
  readonly paramSchema: Readonly<Record<string, unknown>>;
}): string {
  return `${tool.name} ${tool.description} ${parameterNames(tool.paramSchema).join(" ")}`;
}

/** The declared property names of a JSON Schema object, sorted. */
export function parameterNames(schema: Readonly<Record<string, unknown>>): readonly string[] {
  const properties = schema["properties"];
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties as Record<string, unknown>).sort();
}
