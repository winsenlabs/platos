// The pure half of `memory`'s two stores: the row mapping and the write guards,
// exercised without a database.
//
// EVERY CASE HERE IS A DECISION THE MAPPING MAKES, not a round trip. The round
// trips are in the integration suites against a real PostgreSQL; what this file
// pins is the branch a stored column takes on the way in and on the way out —
// which value is trusted, which is refused, and which shape a row written by an
// older binary falls into. Those are the branches a mutation can flip while
// every container suite still passes, because a container suite only ever reads
// rows THIS binary wrote.
//
// THE GUARD CASES ARE NOT A RESTATEMENT OF THE CONSTRAINTS. Each one is a value
// the CONTEXT'S OWN fixtures or domain produce and the canonical schema refuses:
// `memoryFixture()` mints `mem-1` for a `@db.Uuid` column, `admitProvenance`
// returns `ok` for a thread and an extractor with no turns that
// `Memory_extraction_provenance_check` forbids, and `InMemoryEmbeddingModel`
// produces vectors of three components for a `vector(1536)` column.

import { describe, expect, test } from "vitest";

import type { Memory, MemoryEntity, MemoryRelationship } from "@platos/context-memory/application/ports/index.js";
import type {
  ContentHash,
  EntityKey,
  MemoryEntityId,
  MemoryId,
  MemoryRelationshipId,
  ProfileKey,
  ThreadId,
  TurnId,
} from "@platos/context-memory/application/ports/index.js";
import { asMemoryIdentifier, environmentScope, memorySubject } from "@platos/context-memory/application/ports/index.js";

import {
  EMBEDDING_DIMENSIONS,
  MEMORY_BASELINE_OUT_OF_RANGE,
  MEMORY_CONFIDENCE_OUT_OF_RANGE,
  MEMORY_CONTENT_HASH_MALFORMED,
  MEMORY_EMBEDDING_DIMENSION,
  MEMORY_EMBEDDING_NOT_FINITE,
  MEMORY_ENTITY_KEY_TOO_LONG,
  MEMORY_IDENTIFIER_NOT_UUID,
  MEMORY_METADATA_NOT_OBJECT,
  MEMORY_PROFILE_KEY_NOT_NORMALISED,
  MEMORY_PROVENANCE_CONTRACT,
  MEMORY_SOURCE_NOT_CANONICAL,
  MEMORY_WEIGHT_NOT_FINITE,
  MemoryWriteRefused,
  requireStorableEntity,
  requireStorableMemory,
  requireStorableRelationship,
  toVectorLiteral,
} from "./memory-guards.js";
import {
  UNKNOWN_MEMORY_KIND,
  UNKNOWN_MEMORY_SOURCE,
  UNKNOWN_MEMORY_VISIBILITY,
  UNREADABLE_MEMORY_METADATA,
  UnreadableMemoryRow,
  memoryWriteData,
  readEnvironmentScope,
  relationshipWriteData,
  toMemory,
  toMemoryEntity,
  toMemoryRelationship,
} from "./memory-rows.js";
import type { MemoryEntityRow, MemoryRelationshipRow, MemoryRow } from "./memory-rows.js";

const ORG = "aaaaaaaa-0001-4000-8000-000000000001";
const PROJ = "aaaaaaaa-0002-4000-8000-000000000002";
const ENV = "aaaaaaaa-0003-4000-8000-000000000003";
const USER = "aaaaaaaa-0004-4000-8000-000000000004";
const AGENT = "aaaaaaaa-0005-4000-8000-000000000005";
const CLUSTER = "aaaaaaaa-0006-4000-8000-000000000006";
const THREAD = "aaaaaaaa-0007-4000-8000-000000000007";
const TURN = "aaaaaaaa-0008-4000-8000-000000000008";
const MEMORY = "aaaaaaaa-0009-4000-8000-000000000009";
const ENTITY = "aaaaaaaa-000a-4000-8000-00000000000a";
const OTHER_ENTITY = "aaaaaaaa-000b-4000-8000-00000000000b";
const EDGE = "aaaaaaaa-000c-4000-8000-00000000000c";
const HASH = "a".repeat(64);
const AT = new Date("2026-05-01T09:00:00.000Z");

const SCOPE = environmentScope(
  asMemoryIdentifier(ORG),
  asMemoryIdentifier(PROJ),
  asMemoryIdentifier(ENV),
);
const SUBJECT = memorySubject(SCOPE, asMemoryIdentifier(USER));

function memoryRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: MEMORY,
    endUserId: USER,
    agentId: AGENT,
    clusterId: null,
    kind: "fact",
    profileKey: null,
    content: "prefers to be called Sam",
    metadata: null,
    visibility: "agent_visible",
    source: "manual",
    sourceThreadId: null,
    sourceTurnIds: [],
    extractorVersion: null,
    originalSource: null,
    originalSourceThreadId: null,
    originalSourceTurnIds: [],
    contentHash: null,
    confidence: null,
    feedbackBaselineConfidence: null,
    lastAccessedAt: null,
    quarantinedAt: null,
    archivedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function memoryValue(overrides: Partial<Memory> = {}): Memory {
  return { ...toMemory(SUBJECT, memoryRow()), ...overrides };
}

function entityRow(overrides: Partial<MemoryEntityRow> = {}): MemoryEntityRow {
  return {
    id: ENTITY,
    endUserId: USER,
    agentId: AGENT,
    clusterId: null,
    entityKey: "acme-corp",
    entityType: "org",
    label: "Acme Corp",
    aliases: ["Acme"],
    metadata: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function relationshipRow(overrides: Partial<MemoryRelationshipRow> = {}): MemoryRelationshipRow {
  return {
    id: EDGE,
    endUserId: USER,
    agentId: AGENT,
    clusterId: null,
    fromEntityId: ENTITY,
    toEntityId: OTHER_ENTITY,
    relationshipType: "works_at",
    weight: null,
    metadata: null,
    sourceMemoryId: null,
    createdAt: AT,
    ...overrides,
  };
}

function refusalCode(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof MemoryWriteRefused) return error.code;
    if (error instanceof UnreadableMemoryRow) return error.code;
    throw error;
  }
  throw new Error("expected a refusal and none was raised");
}

describe("toMemory", () => {
  test("carries the caller's subject rather than rebuilding one from the row", () => {
    // `Memory.environmentId` is ONE id and `MemorySubject` carries THREE, so a
    // row cannot name the scope it belongs to. Every read on this port is
    // already narrowed by the caller's subject, and this is where that becomes
    // the value on the aggregate.
    const memory = toMemory(SUBJECT, memoryRow());
    expect(memory.subject).toBe(SUBJECT);
    expect(memory.subject.environment.organizationId).toBe(ORG);
  });

  test("reads visibility, not the derived boolean, and never returns a vector", () => {
    // `Memory_visibility_check` is a PAIR constraint, and `visibility` is the
    // authoritative half. The row type carries no `agentVisible` at all, so the
    // mapping physically cannot prefer it — and `MEMORY_COLUMNS` does not select
    // it, so it never travels.
    expect(toMemory(SUBJECT, memoryRow({ visibility: "hidden" })).visibility).toBe("hidden");
    expect("embedding" in toMemory(SUBJECT, memoryRow())).toBe(false);
  });

  test("refuses a kind, a source and a visibility this binary has not heard of, each with its own code", () => {
    // The three come back from an expand/contract window or from the legacy
    // normalisation pass, and they are three different operational events. One
    // shared code would make them one line in a log.
    expect(refusalCode(() => toMemory(SUBJECT, memoryRow({ kind: "atom" })))).toBe(UNKNOWN_MEMORY_KIND);
    expect(refusalCode(() => toMemory(SUBJECT, memoryRow({ source: "turn" })))).toBe(UNKNOWN_MEMORY_SOURCE);
    expect(refusalCode(() => toMemory(SUBJECT, memoryRow({ visibility: "subject" })))).toBe(
      UNKNOWN_MEMORY_VISIBILITY,
    );
  });

  test("refuses a metadata root that is not an object, and reads one that is", () => {
    expect(refusalCode(() => toMemory(SUBJECT, memoryRow({ metadata: ["a"] })))).toBe(
      UNREADABLE_MEMORY_METADATA,
    );
    expect(toMemory(SUBJECT, memoryRow({ metadata: { topic: "names" } })).metadata).toEqual({
      topic: "names",
    });
  });

  test("carries the three inert provenance columns without resolving them", () => {
    // The schema's own comment calls them "inert provenance retained across
    // import and legacy normalization; never resolved as live FKs" — and
    // `originalSourceThreadId` is TEXT, not a uuid, so a mapper that branded it
    // like the live column would be claiming a reference it cannot honour.
    const memory = toMemory(
      SUBJECT,
      memoryRow({
        originalSource: "vector_store",
        originalSourceThreadId: "legacy-thread-77",
        originalSourceTurnIds: ["legacy-turn-1"],
      }),
    );
    expect(memory.provenance.originalSource).toBe("vector_store");
    expect(memory.provenance.originalSourceThreadId).toBe("legacy-thread-77");
    expect(memory.provenance.originalSourceTurnIds).toEqual(["legacy-turn-1"]);
  });
});

describe("memoryWriteData", () => {
  test("derives agentVisible from visibility, in all three directions", () => {
    // The pair constraint admits exactly `('agent_visible', TRUE)`,
    // `('hidden', FALSE)` and `('private', FALSE)`. Nothing accepts the boolean
    // from a caller, so the pair cannot disagree.
    expect(memoryWriteData(memoryValue({ visibility: "agent_visible" })).agentVisible).toBe(true);
    expect(memoryWriteData(memoryValue({ visibility: "hidden" })).agentVisible).toBe(false);
    expect(memoryWriteData(memoryValue({ visibility: "private" })).agentVisible).toBe(false);
  });

  test("names no ownership column, so no update can move one", () => {
    // `Memory_owner_immutable` covers six columns. Five of them are not in this
    // payload at all, which is stronger than checking them: a statement built
    // from it cannot carry a value for a column it does not mention.
    const data: Record<string, unknown> = { ...memoryWriteData(memoryValue()) };
    for (const column of ["environmentId", "endUserId", "agentId", "clusterId", "sourceThreadId"]) {
      expect(Object.hasOwn(data, column)).toBe(false);
    }
    // The SIXTH is present, and that is the finding rather than an oversight:
    // `mergeRepeatedExtraction` takes the newer extractor version and the
    // immutability rule names that column as an ownership key.
    expect(Object.hasOwn(data, "extractorVersion")).toBe(true);
  });
});

describe("relationshipWriteData", () => {
  test("names only the four columns the immutability rule leaves alone", () => {
    expect(Object.keys(relationshipWriteData(toMemoryRelationship(SUBJECT, relationshipRow()))).sort()).toEqual([
      "metadata",
      "relationshipType",
      "sourceMemoryId",
      "weight",
    ]);
  });
});

describe("requireStorableMemory", () => {
  test("refuses the id the context's own fixtures mint", () => {
    // `memoryFixture()` in `application/testing/fixtures.ts` mints `mem-1`, and
    // every use-case suite in the context passes with it.
    expect(refusalCode(() => requireStorableMemory(memoryValue({ memoryId: asMemoryIdentifier<MemoryId>("mem-1") })))).toBe(
      MEMORY_IDENTIFIER_NOT_UUID,
    );
  });

  test("refuses a thread and an extractor with NO turns, which the domain admits", () => {
    // `admitProvenance` refuses turns without a thread and nothing else, so this
    // shape returns `ok` from the domain, is stored by
    // `InMemoryMemoryRepository`, and satisfies NEITHER branch of
    // `Memory_extraction_provenance_check`.
    const halfExtracted = memoryValue({
      contentHash: asMemoryIdentifier<ContentHash>(HASH),
      provenance: {
        sourceThreadId: asMemoryIdentifier<ThreadId>(THREAD),
        sourceTurnIds: [],
        extractorVersion: "extractor-v3",
        originalSource: null,
        originalSourceThreadId: null,
        originalSourceTurnIds: [],
      },
    });
    expect(refusalCode(() => requireStorableMemory(halfExtracted))).toBe(MEMORY_PROVENANCE_CONTRACT);
  });

  test("refuses turns claimed with no extractor, which is the OTHER branch", () => {
    const turnsWithoutExtractor = memoryValue({
      provenance: {
        sourceThreadId: asMemoryIdentifier<ThreadId>(THREAD),
        sourceTurnIds: [asMemoryIdentifier<TurnId>(TURN)],
        extractorVersion: null,
        originalSource: null,
        originalSourceThreadId: null,
        originalSourceTurnIds: [],
      },
    });
    expect(refusalCode(() => requireStorableMemory(turnsWithoutExtractor))).toBe(
      MEMORY_PROVENANCE_CONTRACT,
    );
  });

  test("admits a fully stated extraction, which is what makes the two refusals above falsifiable", () => {
    expect(() =>
      requireStorableMemory(
        memoryValue({
          source: "extracted",
          contentHash: asMemoryIdentifier<ContentHash>(HASH),
          provenance: {
            sourceThreadId: asMemoryIdentifier<ThreadId>(THREAD),
            sourceTurnIds: [asMemoryIdentifier<TurnId>(TURN)],
            extractorVersion: "extractor-v3",
            originalSource: null,
            originalSourceThreadId: null,
            originalSourceTurnIds: [],
          },
        }),
      ),
    ).not.toThrow();
  });

  test("refuses an upper-case digest, which is a different string to PostgreSQL", () => {
    expect(
      refusalCode(() => requireStorableMemory(memoryValue({ contentHash: asMemoryIdentifier<ContentHash>(HASH.toUpperCase()) }))),
    ).toBe(MEMORY_CONTENT_HASH_MALFORMED);
  });

  test("tells the two confidence constraints apart", () => {
    // They are SEPARATE constraints on separate columns —
    // `Memory_confidence_check` and `Memory_feedback_baseline_confidence_check`
    // — so they carry separate codes.
    expect(
      refusalCode(() =>
        requireStorableMemory(memoryValue({ confidence: { confidence: 1.5, feedbackBaselineConfidence: null } })),
      ),
    ).toBe(MEMORY_CONFIDENCE_OUT_OF_RANGE);
    expect(
      refusalCode(() =>
        requireStorableMemory(
          memoryValue({ confidence: { confidence: null, feedbackBaselineConfidence: Number.NaN } }),
        ),
      ),
    ).toBe(MEMORY_BASELINE_OUT_OF_RANGE);
  });

  test("refuses a source outside the CHECK and a profile key in an unstored spelling", () => {
    expect(refusalCode(() => requireStorableMemory(memoryValue({ source: "turn" as Memory["source"] })))).toBe(
      MEMORY_SOURCE_NOT_CANONICAL,
    );
    expect(
      refusalCode(() =>
        requireStorableMemory(memoryValue({ kind: "profile", profileKey: asMemoryIdentifier<ProfileKey>("Role") })),
      ),
    ).toBe(MEMORY_PROFILE_KEY_NOT_NORMALISED);
  });

  test("refuses metadata whose root is an array", () => {
    expect(
      refusalCode(() =>
        requireStorableMemory(memoryValue({ metadata: ["a"] as unknown as Memory["metadata"] })),
      ),
    ).toBe(MEMORY_METADATA_NOT_OBJECT);
  });
});

describe("requireStorableEntity and requireStorableRelationship", () => {
  test("refuse the ids the context's own fixtures mint", () => {
    const entity: MemoryEntity = { ...toMemoryEntity(SUBJECT, entityRow()), entityId: asMemoryIdentifier<MemoryEntityId>("ent-1") };
    expect(refusalCode(() => requireStorableEntity(entity))).toBe(MEMORY_IDENTIFIER_NOT_UUID);
    const edge: MemoryRelationship = {
      ...toMemoryRelationship(SUBJECT, relationshipRow()),
      relationshipId: asMemoryIdentifier<MemoryRelationshipId>("rel-1"),
    };
    expect(refusalCode(() => requireStorableRelationship(edge))).toBe(MEMORY_IDENTIFIER_NOT_UUID);
  });

  test("refuse an entity key longer than the partial unique indexes carry", () => {
    const entity: MemoryEntity = {
      ...toMemoryEntity(SUBJECT, entityRow()),
      entityKey: asMemoryIdentifier<EntityKey>("k".repeat(61)),
    };
    expect(refusalCode(() => requireStorableEntity(entity))).toBe(MEMORY_ENTITY_KEY_TOO_LONG);
  });

  test("refuse a NaN weight, which double precision would have stored", () => {
    const edge: MemoryRelationship = {
      ...toMemoryRelationship(SUBJECT, relationshipRow()),
      weight: Number.NaN,
    };
    expect(refusalCode(() => requireStorableRelationship(edge))).toBe(MEMORY_WEIGHT_NOT_FINITE);
  });

  test("admit the shapes the schema holds, so the refusals above are not vacuous", () => {
    expect(() => requireStorableEntity(toMemoryEntity(SUBJECT, entityRow({ clusterId: CLUSTER })))).not.toThrow();
    expect(() =>
      requireStorableRelationship(toMemoryRelationship(SUBJECT, relationshipRow({ weight: 0.25 }))),
    ).not.toThrow();
  });
});

describe("toVectorLiteral", () => {
  test("refuses the three-component vector the context's embedding double produces", () => {
    expect(refusalCode(() => toVectorLiteral("Memory.embedding", [0.1, 0.2, 0.3]))).toBe(
      MEMORY_EMBEDDING_DIMENSION,
    );
  });

  test("refuses NaN and Infinity, which double precision stores and pgvector does not", () => {
    const withNaN = Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, index) =>
      index === 7 ? Number.NaN : 0,
    );
    const withInfinity = Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, index) =>
      index === 7 ? Number.POSITIVE_INFINITY : 0,
    );
    expect(refusalCode(() => toVectorLiteral("Memory.embedding", withNaN))).toBe(MEMORY_EMBEDDING_NOT_FINITE);
    expect(refusalCode(() => toVectorLiteral("Memory.embedding", withInfinity))).toBe(
      MEMORY_EMBEDDING_NOT_FINITE,
    );
  });

  test("renders the bracketed literal pgvector parses", () => {
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, index) => (index === 0 ? 1 : 0));
    const literal = toVectorLiteral("Memory.embedding", vector);
    expect(literal.startsWith("[1,0,0")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
    expect(literal.split(",")).toHaveLength(EMBEDDING_DIMENSIONS);
  });
});

describe("readEnvironmentScope", () => {
  test("rebuilds all three ids from the joined ancestry", () => {
    // `MessageRating` carries `environmentId` and nothing above it, and
    // `RatingRevision` carries a whole scope. This is the only mapping in the
    // package that assembles one from a join rather than from a caller.
    const scope = readEnvironmentScope(ENV, { projectId: PROJ, project: { organizationId: ORG } });
    expect(scope).toEqual(SCOPE);
  });
});
