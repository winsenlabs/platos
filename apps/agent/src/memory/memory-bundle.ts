import { z } from "zod";
import {
  isMemorySource,
  isMemoryVisibility,
  type MemoryKind,
  type MemorySource,
  type MemoryVisibility,
} from "@platos/tenancy-database";
import { requireValidMemoryPayload } from "./memory-kind.validator";

const nonEmpty = z.string().trim().min(1);
const optionalDate = z.union([z.string().datetime({ offset: true }), z.date(), z.null()]).optional();
const optionalString = z.union([z.string(), z.null()]).optional();

const rawMemory = z.object({
  id: nonEmpty,
  kind: nonEmpty,
  content: z.string(),
  metadata: z.unknown().optional(),
  visibility: nonEmpty,
  agentVisible: z.boolean(),
  source: nonEmpty,
  sourceThreadId: optionalString,
  sourceTurnIds: z.array(z.string()).optional(),
  sourceMessageIds: z.array(z.string()).optional(),
  extractorVersion: optionalString,
  originalSource: optionalString,
  originalSourceThreadId: optionalString,
  originalSourceTurnIds: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
  lastAccessedAt: optionalDate,
  quarantinedAt: optionalDate,
  archivedAt: optionalDate,
}).passthrough();

const rawEntity = z.object({
  id: nonEmpty,
  entityKey: nonEmpty,
  entityType: nonEmpty,
  label: nonEmpty,
  aliases: z.array(z.string()).default([]),
  metadata: z.unknown().optional(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
}).passthrough();

const rawRelationship = z.object({
  id: nonEmpty,
  fromEntityId: nonEmpty,
  toEntityId: nonEmpty,
  fromEntityKey: nonEmpty,
  toEntityKey: nonEmpty,
  relationshipType: nonEmpty,
  weight: z.number().min(0).max(1).nullable().optional(),
  metadata: z.unknown().optional(),
  sourceMemoryId: optionalString,
  createdAt: optionalDate,
}).passthrough();

const rawBundle = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: optionalDate,
  memories: z.array(rawMemory),
  entities: z.array(rawEntity),
  relationships: z.array(rawRelationship),
}).passthrough();

export interface ValidatedBundleMemory {
  exportedId: string;
  kind: MemoryKind;
  content: string;
  metadata: unknown;
  visibility: MemoryVisibility;
  agentVisible: boolean;
  source: MemorySource;
  sourceThreadId: string | null;
  sourceTurnIds: string[];
  extractorVersion: string | null;
  originalSource: string | null;
  originalSourceThreadId: string | null;
  originalSourceTurnIds: string[];
  confidence: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  lastAccessedAt: Date | null;
  quarantinedAt: Date | null;
  archivedAt: Date | null;
}

export interface ValidatedBundleEntity {
  exportedId: string;
  entityKey: string;
  entityType: string;
  label: string;
  aliases: string[];
  metadata: unknown;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface ValidatedBundleRelationship {
  exportedId: string;
  fromEntityId: string;
  toEntityId: string;
  fromEntityKey: string;
  toEntityKey: string;
  relationshipType: string;
  weight: number | null;
  metadata: unknown;
  sourceMemoryId: string | null;
  createdAt: Date | null;
}

export interface ValidatedMemoryBundle {
  version: 1 | 2;
  memories: ValidatedBundleMemory[];
  entities: ValidatedBundleEntity[];
  relationships: ValidatedBundleRelationship[];
}

export function validateMemoryBundle(value: unknown): ValidatedMemoryBundle {
  const parsed = rawBundle.safeParse(value);
  if (!parsed.success) {
    throw bundleError("MEMORY_IMPORT_INVALID_BUNDLE", "bundle does not match the versioned Memory export contract", parsed.error.issues);
  }

  const memoryIds = uniqueSet(parsed.data.memories.map((row) => row.id), "memory id");
  const entityIds = uniqueSet(parsed.data.entities.map((row) => row.id), "entity id");
  const entityKeys = uniqueSet(parsed.data.entities.map((row) => row.entityKey), "entity key");
  const entityKeyById = new Map(parsed.data.entities.map((row) => [row.id, row.entityKey] as const));
  uniqueSet(parsed.data.relationships.map((row) => row.id), "relationship id");

  const memories = parsed.data.memories.map((row, index): ValidatedBundleMemory => {
    if (!isMemoryVisibility(row.visibility) || row.agentVisible !== (row.visibility === "agent_visible")) {
      throw bundleError(
        "MEMORY_IMPORT_INVALID_VISIBILITY",
        `memories[${index}] must use a canonical visibility with a matching agentVisible flag`,
      );
    }
    if (!isMemorySource(row.source)) {
      throw bundleError("MEMORY_IMPORT_INVALID_SOURCE", `memories[${index}] has an invalid source`);
    }
    const validated = requireValidMemoryPayload({
      kind: row.kind,
      content: row.content,
      metadata: row.metadata,
    });
    return {
      exportedId: row.id,
      kind: validated.kind,
      content: validated.content,
      metadata: validated.metadata,
      visibility: row.visibility,
      agentVisible: row.agentVisible,
      source: row.source,
      sourceThreadId: row.sourceThreadId ?? null,
      sourceTurnIds: Array.from(new Set(row.sourceTurnIds ?? row.sourceMessageIds ?? [])),
      extractorVersion: row.extractorVersion ?? null,
      originalSource: row.originalSource ?? null,
      originalSourceThreadId: row.originalSourceThreadId ?? null,
      originalSourceTurnIds: Array.from(new Set(row.originalSourceTurnIds ?? [])),
      confidence: row.confidence ?? null,
      createdAt: asOptionalDate(row.createdAt),
      updatedAt: asOptionalDate(row.updatedAt),
      lastAccessedAt: asOptionalDate(row.lastAccessedAt),
      quarantinedAt: asOptionalDate(row.quarantinedAt),
      archivedAt: asOptionalDate(row.archivedAt),
    };
  });

  const entities = parsed.data.entities.map((row): ValidatedBundleEntity => ({
    exportedId: row.id,
    entityKey: row.entityKey,
    entityType: row.entityType,
    label: row.label,
    aliases: Array.from(new Set(row.aliases)),
    metadata: row.metadata ?? null,
    createdAt: asOptionalDate(row.createdAt),
    updatedAt: asOptionalDate(row.updatedAt),
  }));

  const relationships = parsed.data.relationships.map((row, index): ValidatedBundleRelationship => {
    if (!entityIds.has(row.fromEntityId) || !entityIds.has(row.toEntityId)) {
      throw bundleError(
        "MEMORY_IMPORT_INVALID_RELATIONSHIP",
        `relationships[${index}] references an entity id outside the bundle`,
      );
    }
    if (!entityKeys.has(row.fromEntityKey) || !entityKeys.has(row.toEntityKey)) {
      throw bundleError(
        "MEMORY_IMPORT_INVALID_RELATIONSHIP",
        `relationships[${index}] references an entity key outside the bundle`,
      );
    }
    if (
      entityKeyById.get(row.fromEntityId) !== row.fromEntityKey ||
      entityKeyById.get(row.toEntityId) !== row.toEntityKey
    ) {
      throw bundleError(
        "MEMORY_IMPORT_INVALID_RELATIONSHIP",
        `relationships[${index}] entity ids and keys identify different bundle rows`,
      );
    }
    if (row.sourceMemoryId && !memoryIds.has(row.sourceMemoryId)) {
      throw bundleError(
        "MEMORY_IMPORT_INVALID_RELATIONSHIP",
        `relationships[${index}].sourceMemoryId is outside the bundle`,
      );
    }
    return {
      exportedId: row.id,
      fromEntityId: row.fromEntityId,
      toEntityId: row.toEntityId,
      fromEntityKey: row.fromEntityKey,
      toEntityKey: row.toEntityKey,
      relationshipType: row.relationshipType,
      weight: row.weight ?? null,
      metadata: row.metadata ?? null,
      sourceMemoryId: row.sourceMemoryId ?? null,
      createdAt: asOptionalDate(row.createdAt),
    };
  });

  return { version: parsed.data.version, memories, entities, relationships };
}

function uniqueSet(values: string[], label: string): Set<string> {
  const set = new Set(values);
  if (set.size !== values.length) {
    throw bundleError("MEMORY_IMPORT_DUPLICATE_IDENTITY", `bundle contains duplicate ${label} values`);
  }
  return set;
}

function asOptionalDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function bundleError(code: string, message: string, details?: unknown): Error {
  const error = new Error(message);
  (error as any).code = code;
  if (details !== undefined) (error as any).validationErrors = details;
  return error;
}
