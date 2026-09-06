// Row -> aggregate mapping for `memory`'s three tables, and the one place a
// stored column is trusted or refused.
//
// Every function here is PURE and takes a STRUCTURAL row type rather than a
// generated one, for the reason `mapping.ts` gives: the generated types come
// from a client that has to be built before it exists, and a mapping suite that
// could only run after `prisma generate` would be a suite nobody runs. The
// structural types are checked against the generated ones where the stores call
// these functions, so a schema change still breaks the build — it just breaks it
// at the call site instead of here.
//
// THE THREE VOCABULARY COLUMNS ARE VALIDATED, NOT CAST, and each refusal has its
// own code. `kind`, `source` and `visibility` arrive from the database as plain
// strings. Casting one to its domain union would make a row written by an older
// binary — or by the normalisation pass in
// `20260824111500_memory_profile_key_and_source_contract`, which rewrote every
// legacy spelling in place — silently become a value this code then makes recall
// decisions with. During an expand/contract window two binaries share one
// database, and "this row is unreadable by this binary" is an operational event
// rather than a crash.
//
// THE PAIR COLUMN IS DERIVED ON THE WAY IN AND IGNORED ON THE WAY OUT.
// `Memory_visibility_check` is a constraint over `visibility` AND `agentVisible`
// together, so nothing in this package accepts an `agentVisible` from a caller:
// `memoryWriteData` derives it with the domain's own `agentVisibleFor`, and
// `toMemory` reads the row's `visibility` and never its boolean. The two cannot
// disagree, and a row whose stored pair somehow disagreed would be read by its
// authoritative half.
//
// THE VECTOR IS NOT HERE AT ALL. `Memory.embedding` and `MemoryEntity.embedding`
// are `Unsupported("vector(1536)")`, which the generated client cannot select or
// write; `memory-vectors.ts` holds the four raw statements that do. Neither
// aggregate carries the column, so there is nothing to map.

import type {
  AgentId,
  ClusterId,
  ContentHash,
  EntityKey,
  EnvironmentScope,
  JsonValue,
  Memory,
  MemoryEntity,
  MemoryMetadata,
  MemoryEntityId,
  MemoryId,
  MemoryRelationship,
  MemoryRelationshipId,
  MemorySource,
  MemorySubject,
  MemoryVisibility,
  ProfileKey,
  ThreadId,
  TurnId,
} from "@platos/context-memory/application/ports/index.js";
import {
  agentVisibleFor,
  asMemoryIdentifier,
  environmentScope,
  isMemoryKind,
  isMemorySource,
  isMemoryVisibility,
  memorySubject,
} from "@platos/context-memory/application/ports/index.js";
import type { MemoryKind } from "@platos/context-memory/application/ports/index.js";

import { nullableJson } from "./client.js";
import { requireStorableMetadata } from "./memory-guards.js";

/** A stored `Memory.kind` this binary does not recognise. */
export const UNKNOWN_MEMORY_KIND = "memory.row.unknown_kind";

/** A stored `Memory.source` this binary does not recognise. */
export const UNKNOWN_MEMORY_SOURCE = "memory.row.unknown_source";

/** A stored `Memory.visibility` this binary does not recognise. */
export const UNKNOWN_MEMORY_VISIBILITY = "memory.row.unknown_visibility";

/** A stored `metadata` whose JSON root is not an object. */
export const UNREADABLE_MEMORY_METADATA = "memory.row.metadata_not_object";

export class UnreadableMemoryRow extends Error {
  readonly code: string;
  readonly column: string;
  readonly value: string;

  constructor(code: string, column: string, value: string) {
    super(`${column} holds ${JSON.stringify(value)}, which this binary cannot read`);
    this.name = "UnreadableMemoryRow";
    this.code = code;
    this.column = column;
    this.value = value;
  }
}

export function readMemoryKind(value: string): MemoryKind {
  if (!isMemoryKind(value)) throw new UnreadableMemoryRow(UNKNOWN_MEMORY_KIND, "Memory.kind", value);
  return value;
}

export function readMemorySource(value: string): MemorySource {
  if (!isMemorySource(value)) throw new UnreadableMemoryRow(UNKNOWN_MEMORY_SOURCE, "Memory.source", value);
  return value;
}

export function readMemoryVisibility(value: string): MemoryVisibility {
  if (!isMemoryVisibility(value)) {
    throw new UnreadableMemoryRow(UNKNOWN_MEMORY_VISIBILITY, "Memory.visibility", value);
  }
  return value;
}

/**
 * A stored `Json?` column, read as the domain's object-or-null.
 *
 * The `*_metadata_json_root` CHECKs make an array or a scalar unstorable, so a
 * row holding one was written by something that bypassed the database — and
 * reading it as `MemoryMetadata` would put a value the type says cannot exist
 * into an aggregate. It is refused with its own code instead.
 */
export function readMemoryMetadata(column: string, value: unknown): MemoryMetadata {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new UnreadableMemoryRow(UNREADABLE_MEMORY_METADATA, column, String(value));
  }
  return value as { readonly [key: string]: JsonValue };
}

/** The three ids a canonical read rebuilds an `EnvironmentScope` from. */
export interface EnvironmentAncestryRow {
  readonly projectId: string;
  readonly project: { readonly organizationId: string };
}

export function readEnvironmentScope(
  environmentId: string,
  ancestry: EnvironmentAncestryRow,
): EnvironmentScope {
  return environmentScope(
    asMemoryIdentifier(ancestry.project.organizationId),
    asMemoryIdentifier(ancestry.projectId),
    asMemoryIdentifier(environmentId),
  );
}

/**
 * Every column a `Memory` read selects, and deliberately no more.
 *
 * `environmentId` is NOT among them: the caller already supplied the subject
 * every statement is narrowed by, and selecting the column back would invite a
 * mapper to trust the row's copy of a value the `WHERE` has already pinned.
 * `agentVisible` is absent for the reason `memoryWriteData` derives it — the
 * pair constraint makes `visibility` the authoritative half. And `embedding` is
 * absent because the client cannot name it at all.
 */
export const MEMORY_COLUMNS = {
  id: true,
  endUserId: true,
  agentId: true,
  clusterId: true,
  kind: true,
  profileKey: true,
  content: true,
  metadata: true,
  visibility: true,
  source: true,
  sourceThreadId: true,
  sourceTurnIds: true,
  extractorVersion: true,
  originalSource: true,
  originalSourceThreadId: true,
  originalSourceTurnIds: true,
  contentHash: true,
  confidence: true,
  feedbackBaselineConfidence: true,
  lastAccessedAt: true,
  quarantinedAt: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Every column a `MemoryEntity` read selects. `embedding` is unnameable. */
export const ENTITY_COLUMNS = {
  id: true,
  endUserId: true,
  agentId: true,
  clusterId: true,
  entityKey: true,
  entityType: true,
  label: true,
  aliases: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Every column a `MemoryRelationship` read selects. The table has no `updatedAt`. */
export const RELATIONSHIP_COLUMNS = {
  id: true,
  endUserId: true,
  agentId: true,
  clusterId: true,
  fromEntityId: true,
  toEntityId: true,
  relationshipType: true,
  weight: true,
  metadata: true,
  sourceMemoryId: true,
  createdAt: true,
} as const;

export interface MemoryRow {
  readonly id: string;
  readonly endUserId: string;
  readonly agentId: string;
  readonly clusterId: string | null;
  readonly kind: string;
  readonly profileKey: string | null;
  readonly content: string;
  readonly metadata: unknown;
  readonly visibility: string;
  readonly source: string;
  readonly sourceThreadId: string | null;
  readonly sourceTurnIds: readonly string[];
  readonly extractorVersion: string | null;
  readonly originalSource: string | null;
  readonly originalSourceThreadId: string | null;
  readonly originalSourceTurnIds: readonly string[];
  readonly contentHash: string | null;
  readonly confidence: number | null;
  readonly feedbackBaselineConfidence: number | null;
  readonly lastAccessedAt: Date | null;
  readonly quarantinedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The subject travels IN rather than out of the row.
 *
 * `Memory.environmentId` is one id and `MemorySubject` carries three, so a row
 * cannot rebuild the scope it belongs to without joining `Environment` and
 * `Project`. Every read on this port is already scoped by the caller's subject,
 * so the subject the caller asked with is the subject the row has — and taking
 * it as a parameter is what keeps a listing of forty rows from being forty
 * joins.
 */
export function toMemory(subject: MemorySubject, row: MemoryRow): Memory {
  return {
    memoryId: asMemoryIdentifier<MemoryId>(row.id),
    subject,
    ownership: {
      agentId: asMemoryIdentifier<AgentId>(row.agentId),
      clusterId: row.clusterId === null ? null : asMemoryIdentifier<ClusterId>(row.clusterId),
    },
    kind: readMemoryKind(row.kind),
    profileKey: row.profileKey === null ? null : asMemoryIdentifier<ProfileKey>(row.profileKey),
    content: row.content,
    metadata: readMemoryMetadata("Memory.metadata", row.metadata),
    visibility: readMemoryVisibility(row.visibility),
    source: readMemorySource(row.source),
    contentHash: row.contentHash === null ? null : asMemoryIdentifier<ContentHash>(row.contentHash),
    provenance: {
      sourceThreadId:
        row.sourceThreadId === null ? null : asMemoryIdentifier<ThreadId>(row.sourceThreadId),
      sourceTurnIds: row.sourceTurnIds.map((turnId) => asMemoryIdentifier<TurnId>(turnId)),
      extractorVersion: row.extractorVersion,
      originalSource: row.originalSource,
      originalSourceThreadId: row.originalSourceThreadId,
      originalSourceTurnIds: [...row.originalSourceTurnIds],
    },
    confidence: {
      confidence: row.confidence,
      feedbackBaselineConfidence: row.feedbackBaselineConfidence,
    },
    lifecycle: {
      lastAccessedAt: row.lastAccessedAt,
      quarantinedAt: row.quarantinedAt,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  };
}

/**
 * Every column of a `Memory` write except the vector and the identity.
 *
 * The return type is SPELLED OUT rather than left as a record, because these
 * objects are SPREAD into a Prisma `data` block: an index-signature type erases
 * every property name on the way in, so a missing required column would be
 * reported as a missing column on the spread rather than as a missing field
 * here, and an extra one would not be reported at all.
 */
export interface MemoryWriteData {
  readonly kind: string;
  readonly profileKey: string | null;
  readonly content: string;
  readonly metadata: ReturnType<typeof nullableJson>;
  readonly agentVisible: boolean;
  readonly visibility: string;
  readonly source: string;
  readonly sourceTurnIds: string[];
  readonly extractorVersion: string | null;
  readonly originalSource: string | null;
  readonly originalSourceThreadId: string | null;
  readonly originalSourceTurnIds: string[];
  readonly contentHash: string | null;
  readonly confidence: number | null;
  readonly feedbackBaselineConfidence: number | null;
  readonly lastAccessedAt: Date | null;
  readonly quarantinedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly updatedAt: Date;
}

export function memoryWriteData(memory: Memory): MemoryWriteData {
  return {
    kind: memory.kind,
    profileKey: memory.profileKey,
    content: memory.content,
    metadata: nullableJson(requireStorableMetadata("Memory.metadata", memory.metadata)),
    // Derived, never accepted: `Memory_visibility_check` is a constraint over
    // the pair, and this is the only expression in the package that writes it.
    agentVisible: agentVisibleFor(memory.visibility),
    visibility: memory.visibility,
    source: memory.source,
    sourceTurnIds: [...memory.provenance.sourceTurnIds],
    extractorVersion: memory.provenance.extractorVersion,
    originalSource: memory.provenance.originalSource,
    originalSourceThreadId: memory.provenance.originalSourceThreadId,
    originalSourceTurnIds: [...memory.provenance.originalSourceTurnIds],
    contentHash: memory.contentHash,
    confidence: memory.confidence.confidence,
    feedbackBaselineConfidence: memory.confidence.feedbackBaselineConfidence,
    lastAccessedAt: memory.lifecycle.lastAccessedAt,
    quarantinedAt: memory.lifecycle.quarantinedAt,
    archivedAt: memory.lifecycle.archivedAt,
    updatedAt: memory.lifecycle.updatedAt,
  };
}

export interface MemoryEntityRow {
  readonly id: string;
  readonly endUserId: string;
  readonly agentId: string;
  readonly clusterId: string | null;
  readonly entityKey: string;
  readonly entityType: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly metadata: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toMemoryEntity(subject: MemorySubject, row: MemoryEntityRow): MemoryEntity {
  return {
    entityId: asMemoryIdentifier<MemoryEntityId>(row.id),
    subject,
    ownership: {
      agentId: asMemoryIdentifier<AgentId>(row.agentId),
      clusterId: row.clusterId === null ? null : asMemoryIdentifier<ClusterId>(row.clusterId),
    },
    entityKey: asMemoryIdentifier<EntityKey>(row.entityKey),
    entityType: row.entityType,
    label: row.label,
    aliases: [...row.aliases],
    metadata: readMemoryMetadata("MemoryEntity.metadata", row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The columns an entity write may set.
 *
 * `entityKey` is deliberately ABSENT from the update path's use of this: the two
 * partial unique indexes are over it, and `enforce_memory_entity_owner_transition`
 * does not guard it — so a rename is a legal statement that would move the row
 * to another node's identity. `applyEntityDraft` in the domain never changes it,
 * and the store does not offer a way to.
 */
export interface EntityWriteData {
  readonly entityType: string;
  readonly label: string;
  readonly aliases: string[];
  readonly metadata: ReturnType<typeof nullableJson>;
  readonly updatedAt: Date;
}

export function entityWriteData(entity: MemoryEntity): EntityWriteData {
  return {
    entityType: entity.entityType,
    label: entity.label,
    aliases: [...entity.aliases],
    metadata: nullableJson(requireStorableMetadata("MemoryEntity.metadata", entity.metadata)),
    updatedAt: entity.updatedAt,
  };
}

export interface MemoryRelationshipRow {
  readonly id: string;
  readonly endUserId: string;
  readonly agentId: string;
  readonly clusterId: string | null;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly relationshipType: string;
  readonly weight: number | null;
  readonly metadata: unknown;
  readonly sourceMemoryId: string | null;
  readonly createdAt: Date;
}

export function toMemoryRelationship(
  subject: MemorySubject,
  row: MemoryRelationshipRow,
): MemoryRelationship {
  return {
    relationshipId: asMemoryIdentifier<MemoryRelationshipId>(row.id),
    subject,
    ownership: {
      agentId: asMemoryIdentifier<AgentId>(row.agentId),
      clusterId: row.clusterId === null ? null : asMemoryIdentifier<ClusterId>(row.clusterId),
    },
    fromEntityId: asMemoryIdentifier<MemoryEntityId>(row.fromEntityId),
    toEntityId: asMemoryIdentifier<MemoryEntityId>(row.toEntityId),
    relationshipType: row.relationshipType,
    weight: row.weight,
    metadata: readMemoryMetadata("MemoryRelationship.metadata", row.metadata),
    sourceMemoryId:
      row.sourceMemoryId === null ? null : asMemoryIdentifier<MemoryId>(row.sourceMemoryId),
    createdAt: row.createdAt,
  };
}

/**
 * The columns an edge write may set.
 *
 * `MemoryRelationship` has NO `updatedAt` column, which is why nothing here
 * stamps one and why the aggregate carries only `createdAt`. The three
 * mutable columns are exactly the four
 * `MemoryRelationship_owner_immutable` leaves alone.
 */
export interface RelationshipWriteData {
  readonly relationshipType: string;
  readonly weight: number | null;
  readonly metadata: ReturnType<typeof nullableJson>;
  readonly sourceMemoryId: string | null;
}

export function relationshipWriteData(relationship: MemoryRelationship): RelationshipWriteData {
  return {
    relationshipType: relationship.relationshipType,
    weight: relationship.weight,
    metadata: nullableJson(
      requireStorableMetadata("MemoryRelationship.metadata", relationship.metadata),
    ),
    sourceMemoryId: relationship.sourceMemoryId,
  };
}

/** The two columns every read on these three tables is narrowed by. */
export function subjectWhere(subject: MemorySubject): {
  readonly environmentId: string;
  readonly endUserId: string;
} {
  return {
    environmentId: subject.environment.environmentId,
    endUserId: subject.endUserId,
  };
}

/** Rebuild the caller's subject for a row read under a bare environment. */
export function subjectOf(environment: EnvironmentScope, endUserId: string): MemorySubject {
  return memorySubject(environment, asMemoryIdentifier(endUserId));
}
