// What the canonical schema refuses that `memory`'s two in-memory doubles hold
// happily — each as a NAMED case against a real PostgreSQL.
//
// EVERY CASE IS A VALUE THE CONTEXT ITSELF PRODUCES. Not one is invented to make
// a guard fire: `memoryFixture()` mints `mem-1` for a `@db.Uuid` column,
// `admitProvenance` returns `ok` for a thread and an extractor with no turns,
// `InMemoryEmbeddingModel.returnWidth(3)` produces a vector for a `vector(1536)`
// column, and every use-case suite in the context passes with all three.
//
// THE GUARD AND THE DATABASE ARE BOTH MEASURED. A refusal caught in TypeScript
// proves the guard; it does not prove the constraint is there. So the cases that
// can are STOOD BESIDE the raw statement the guard was written from — applied
// through the ORM's own CLI, which is outside this package's write path — and
// PostgreSQL is asked directly. A guard whose constraint had been dropped from
// the schema would pass the first half and fail the second.
//
// THE ANCESTRY RULE HAS NO GUARD AND CANNOT HAVE ONE. `enforce_domain_ancestry`
// asks questions about OTHER ROWS — is this agent bound to this cluster, is this
// turn in this thread — that a store cannot answer without the reads it exists to
// make unnecessary. Those cases let the database refuse and assert the store
// reported it as an outcome rather than as a rejected promise.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AgentId,
  ClusterId,
  EndUserId,
  ContentHash,
  EntityKey,
  MemoryId,
  ProfileKey,
  ThreadId,
  TransactionScope,
  TurnId,
} from "@platos/context-memory/application/ports/index.js";
import { asMemoryIdentifier } from "@platos/context-memory/application/ports/index.js";

import type { MemoryChain, MemoryHarness } from "./memory-harness.js";
import { edgeDraft, entityDraft, memoryDraft, startMemoryHarness } from "./memory-harness.js";
import {
  MEMORY_CONTENT_HASH_MALFORMED,
  MEMORY_EMBEDDING_DIMENSION,
  MEMORY_IDENTIFIER_NOT_UUID,
  MEMORY_PROVENANCE_CONTRACT,
} from "./memory-guards.js";
import { UNKNOWN_MEMORY_KIND } from "./memory-rows.js";

let harness: MemoryHarness;
let chain: MemoryChain;
let foreign: MemoryChain;

const AT = new Date("2026-05-01T09:00:00.000Z");
const HASH = "e".repeat(64);

beforeAll(async () => {
  harness = await startMemoryHarness();
  chain = await harness.seedChain(await harness.freshScope());
  foreign = await harness.foreignChain();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function id(kind: string): string {
  return harness.base.freshId(kind);
}

/** The refusal reason, which leads with the distinct code. */
async function refusalOf(work: Promise<{ readonly ok: boolean }>): Promise<string> {
  const result = (await work) as { ok: boolean; error?: { details?: { reason?: string } } };
  expect(result.ok).toBe(false);
  return result.error?.details?.reason ?? "";
}

/**
 * One unit of work per case.
 *
 * `TransactionScope` is the KERNEL's, re-exported unchanged by both port entry
 * points, so the handle tenancy's `UnitOfWork` mints is the handle `memory`'s
 * writes take. That is not a coincidence to lean on quietly: it is ADR M0.3 §3's
 * "no context passes a vendor transaction handle across a port" holding, and it
 * is why one transaction can span nine owners' rows.
 */
function write<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work);
}

describe("column types the doubles do not have", () => {
  test("`mem-1` — the id the context's own fixture mints — is refused for a @db.Uuid column", async () => {
    const reason = await refusalOf(
      write((transaction) =>
        harness.stores.memory.insertMemory(
          {
            memory: memoryDraft(chain, id("0070"), AT, {
              memoryId: asMemoryIdentifier<MemoryId>("mem-1"),
            }),
            embedding: { action: "keep" },
          },
          transaction,
        ),
      ),
    );
    expect(reason.startsWith(MEMORY_IDENTIFIER_NOT_UUID)).toBe(true);
  });

  test("a three-component vector is refused for a vector(1536) column, and the ROW is not written either", async () => {
    // The guard runs before the `create`, so the refusal costs no statement and
    // leaves no row — which is what keeps the enclosing transaction usable.
    const memoryId = id("0071");
    const reason = await refusalOf(
      write((transaction) =>
        harness.stores.memory.insertMemory(
          {
            memory: memoryDraft(chain, memoryId, AT),
            embedding: { action: "set", vector: [0.1, 0.2, 0.3] },
          },
          transaction,
        ),
      ),
    );
    expect(reason.startsWith(MEMORY_EMBEDDING_DIMENSION)).toBe(true);
    expect(await harness.base.client.memory.count({ where: { id: memoryId } })).toBe(0);
  });

  test("and pgvector really does refuse it — the constraint, not only the guard", () => {
    // The guard is written FROM this behaviour; this is the behaviour. Applied
    // through the ORM's own CLI, which is outside this package's write path.
    expect(() =>
      harness.applyPeerRows(`SELECT '[0.1,0.2,0.3]'::vector(1536);`),
    ).toThrow();
  });
});

describe("Memory_extraction_provenance_check", () => {
  test("a thread and an extractor with NO turns — which the domain ADMITS — is refused", async () => {
    const reason = await refusalOf(
      write((transaction) =>
        harness.stores.memory.insertMemory(
          {
            memory: memoryDraft(chain, id("0072"), AT, {
              source: "extracted",
              contentHash: asMemoryIdentifier<ContentHash>(HASH),
              provenance: {
                sourceThreadId: asMemoryIdentifier<ThreadId>(chain.threadId),
                sourceTurnIds: [],
                extractorVersion: "extractor-v3",
                originalSource: null,
                originalSourceThreadId: null,
                originalSourceTurnIds: [],
              },
            }),
            embedding: { action: "keep" },
          },
          transaction,
        ),
      ),
    );
    expect(reason.startsWith(MEMORY_PROVENANCE_CONTRACT)).toBe(true);
  });

  test("and the CHECK really refuses it, so the guard is transcribing rather than inventing", () => {
    expect(() =>
      harness.applyPeerRows(
        `INSERT INTO "Memory" ("id","environmentId","endUserId","agentId","clusterId","kind","content",
                              "agentVisible","visibility","source","sourceThreadId","sourceTurnIds",
                              "extractorVersion","contentHash","createdAt","updatedAt")
         VALUES ('${id("0073")}','${chain.scope.environmentId}','${chain.endUserId}','${chain.agentId}',
                 '${chain.clusterId}','fact','half stated', true,'agent_visible','extracted',
                 '${chain.threadId}', ARRAY[]::uuid[], 'extractor-v3','${HASH}',
                 '2026-05-01T09:00:00Z','2026-05-01T09:00:00Z');`,
      ),
    ).toThrow();
  });

  test("an UPPER-CASE digest is refused: the CHECK is `~ '^[0-9a-f]{64}$'`", async () => {
    const reason = await refusalOf(
      write((transaction) =>
        harness.stores.memory.insertMemory(
          {
            memory: memoryDraft(chain, id("0074"), AT, {
              contentHash: asMemoryIdentifier<ContentHash>(HASH.toUpperCase()),
            }),
            embedding: { action: "keep" },
          },
          transaction,
        ),
      ),
    );
    expect(reason.startsWith(MEMORY_CONTENT_HASH_MALFORMED)).toBe(true);
  });

  test("a fully stated extraction IS stored, so every refusal above is falsifiable", async () => {
    const memoryId = id("0075");
    const stored = await write((transaction) =>
      harness.stores.memory.insertMemory(
        {
          memory: memoryDraft(chain, memoryId, AT, {
            source: "extracted",
            contentHash: asMemoryIdentifier<ContentHash>(HASH),
            provenance: {
              sourceThreadId: asMemoryIdentifier<ThreadId>(chain.threadId),
              sourceTurnIds: [asMemoryIdentifier<TurnId>(chain.turnId)],
              extractorVersion: "extractor-v3",
              originalSource: null,
              originalSourceThreadId: null,
              originalSourceTurnIds: [],
            },
          }),
          embedding: { action: "keep" },
        },
        transaction,
      ),
    );
    expect(stored.ok).toBe(true);
    expect(await harness.base.client.memory.count({ where: { id: memoryId } })).toBe(1);
  });
});

describe("Memory_visibility_check — the PAIR constraint", () => {
  test("a private row stores agentVisible = FALSE, because the store derives it", async () => {
    const memoryId = id("0076");
    await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, memoryId, AT, { visibility: "private" }), embedding: { action: "keep" } },
        transaction,
      ),
    );
    const row = await harness.base.client.memory.findUnique({
      where: { id: memoryId },
      select: { visibility: true, agentVisible: true },
    });
    expect(row).toEqual({ visibility: "private", agentVisible: false });
  });

  test("and a MISMATCHED pair is refused by the database, which is why nothing accepts the boolean", () => {
    expect(() =>
      harness.applyPeerRows(
        `INSERT INTO "Memory" ("id","environmentId","endUserId","agentId","clusterId","kind","content",
                              "agentVisible","visibility","source","createdAt","updatedAt")
         VALUES ('${id("0077")}','${chain.scope.environmentId}','${chain.endUserId}','${chain.agentId}',
                 '${chain.clusterId}','fact','mismatched', true,'private','manual',
                 '2026-05-01T09:00:00Z','2026-05-01T09:00:00Z');`,
      ),
    ).toThrow();
  });
});

describe("enforce_domain_ancestry — the rules a store cannot pre-check", () => {
  test("a clustered memory whose agent is NOT bound to that cluster is refused", async () => {
    // `outsideAgentId` is bound with `clusterId IS NULL`. The rule's
    // `LEFT JOIN AgentBinding ... AND binding."clusterId" = cluster.id` finds
    // nothing, so the row is refused — and no guard in this package could have
    // known that without the very read the port exists to avoid.
    const outcome = await write((transaction) =>
      harness.stores.memory.insertMemory(
        {
          memory: memoryDraft(chain, id("0078"), AT, {
            ownership: {
              agentId: asMemoryIdentifier<AgentId>(chain.outsideAgentId),
              clusterId: asMemoryIdentifier<ClusterId>(chain.clusterId),
            },
          }),
          embedding: { action: "keep" },
        },
        transaction,
      ),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("MEMORY_REPOSITORY_UNAVAILABLE");
  });

  test("a source turn from ANOTHER thread is refused, so provenance cannot be claimed", async () => {
    const outcome = await write((transaction) =>
      harness.stores.memory.insertMemory(
        {
          memory: memoryDraft(chain, id("0079"), AT, {
            source: "extracted",
            contentHash: asMemoryIdentifier<ContentHash>("f".repeat(64)),
            provenance: {
              sourceThreadId: asMemoryIdentifier<ThreadId>(chain.threadId),
              // A turn that belongs to `standaloneThreadId`, not to this thread.
              sourceTurnIds: [asMemoryIdentifier<TurnId>(chain.standaloneTurnId)],
              extractorVersion: "extractor-v3",
              originalSource: null,
              originalSourceThreadId: null,
              originalSourceTurnIds: [],
            },
          }),
          embedding: { action: "keep" },
        },
        transaction,
      ),
    );
    expect(outcome.ok).toBe(false);
  });

  test("an edge between endpoints in DIFFERENT ownership domains is refused", async () => {
    // The rule demands, for a clustered edge, that BOTH endpoints carry that
    // very cluster. A clustered node and a standalone node are two identity
    // domains, and the schema will not let an edge straddle them.
    const clustered = id("007a");
    const standalone = id("007b");
    await write(async (transaction) => {
      await harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, clustered, AT, { entityKey: asMemoryIdentifier<EntityKey>("split-a") }),
        transaction,
      );
      await harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, standalone, AT, {
          entityKey: asMemoryIdentifier<EntityKey>("split-b"),
          ownership: { agentId: asMemoryIdentifier<AgentId>(chain.outsideAgentId), clusterId: null },
        }),
        transaction,
      );
    });

    const outcome = await write((transaction) =>
      harness.stores.memoryGraph.insertRelationship(
        edgeDraft(chain, id("007c"), clustered, standalone, AT),
        transaction,
      ),
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("tenant isolation", () => {
  test("a memory in another tenant is invisible to every read on this port", async () => {
    const foreignMemory = id("007d");
    await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(foreign, foreignMemory, AT), embedding: { action: "keep" } },
        transaction,
      ),
    );

    const byId = await harness.stores.memory.findMemory(
      chain.subject,
      [asMemoryIdentifier<AgentId>(chain.agentId), asMemoryIdentifier<AgentId>(foreign.agentId)],
      asMemoryIdentifier<MemoryId>(foreignMemory),
    );
    expect(byId.ok && byId.value).toBeNull();

    const listed = await harness.stores.memory.listMemories(
      {
        subject: chain.subject,
        agentIds: [asMemoryIdentifier<AgentId>(foreign.agentId)],
        kind: null,
        source: null,
        visibilities: [],
        archiveState: "all",
        excludeRag: false,
        excludeQuarantined: false,
      },
      50,
      0,
    );
    expect(listed.ok && listed.value).toEqual([]);

    // And the row IS there — otherwise the two misses above would be vacuous.
    expect(await harness.base.client.memory.count({ where: { id: foreignMemory } })).toBe(1);
  });

  test("`touchAccessed` names an environment, and an id from another one is not stamped", async () => {
    // M-M18's guard. It is the one write on this port that takes NO
    // `TransactionScope` — a failed access stamp must not fail a recall that is
    // already correct — so a caller has no scope object it could have been
    // checked against, and the `WHERE` is the only thing that scopes it.
    const foreignMemory = id("007c");
    await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(foreign, foreignMemory, AT), embedding: { action: "keep" } },
        transaction,
      ),
    );

    const touched = await harness.stores.memory.touchAccessed(
      chain.scope,
      [asMemoryIdentifier<MemoryId>(foreignMemory)],
      new Date("2026-07-01T00:00:00.000Z"),
    );
    expect(touched.ok && touched.value).toBe(0);
    const row = await harness.base.client.memory.findUnique({
      where: { id: foreignMemory },
      select: { lastAccessedAt: true },
    });
    expect(row).toEqual({ lastAccessedAt: null });
  });

  test("an erasure names one subject and destroys nothing of another's", async () => {
    const mine = id("007e");
    const theirs = id("007f");
    await write(async (transaction) => {
      await harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, mine, AT, { content: "mine" }), embedding: { action: "keep" } },
        transaction,
      );
      await harness.stores.memory.insertMemory(
        { memory: memoryDraft(foreign, theirs, AT, { content: "theirs" }), embedding: { action: "keep" } },
        transaction,
      );
    });

    const erased = await write((transaction) =>
      harness.stores.memory.deleteMemoriesForSubject(
        { environment: chain.scope, endUserId: asMemoryIdentifier<EndUserId>(chain.endUserId) },
        transaction,
      ),
    );
    expect(erased.ok).toBe(true);
    expect(await harness.base.client.memory.count({ where: { id: mine } })).toBe(0);
    expect(await harness.base.client.memory.count({ where: { id: theirs } })).toBe(1);
  });
});

describe("an expand/contract read", () => {
  test("a `kind` written by an OLDER binary is refused as an unreadable row, not cast past", async () => {
    // The 2026-08-24 migration rewrote every legacy `source` spelling in place;
    // nothing did the same for `kind`, and two binaries share one database
    // during a deploy. A cast would make this row a `MemoryKind` this code then
    // makes recall decisions with.
    const memoryId = id("0080");
    harness.applyPeerRows(
      `INSERT INTO "Memory" ("id","environmentId","endUserId","agentId","clusterId","kind","content",
                            "agentVisible","visibility","source","createdAt","updatedAt")
       VALUES ('${memoryId}','${chain.scope.environmentId}','${chain.endUserId}','${chain.agentId}',
               '${chain.clusterId}','atom','from a newer binary', true,'agent_visible','manual',
               '2026-05-01T09:00:00Z','2026-05-01T09:00:00Z');`,
    );

    const read = await harness.stores.memory.findMemory(
      chain.subject,
      [asMemoryIdentifier<AgentId>(chain.agentId)],
      asMemoryIdentifier<MemoryId>(memoryId),
    );
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe("MEMORY_REPOSITORY_UNAVAILABLE");
      expect(String(read.error.details?.["reason"] ?? "").startsWith(UNKNOWN_MEMORY_KIND)).toBe(true);
    }
  });
});

describe("the profile key has no unique index, and the migration says so on purpose", () => {
  test("a SECOND profile row for one (subject, ownership, key) is STORED — the double refuses it", async () => {
    // `20260824111500_memory_profile_key_and_source_contract` ends with
    // "Memory_profile_standalone_key and Memory_profile_cluster_key are created
    // by MemoryProfileBackfillService only after encrypted metadata has been
    // decrypted, normalized, deduplicated, remapped, and verified atomically" —
    // and does not create them. `InMemoryMemoryRepository.insertMemory` refuses
    // the second row outright.
    const first = id("0081");
    const second = id("0082");
    const profile = { kind: "profile" as const, profileKey: asMemoryIdentifier<ProfileKey>("role") };
    const one = await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, first, AT, { ...profile, content: "staff engineer" }), embedding: { action: "clear" } },
        transaction,
      ),
    );
    const two = await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, second, AT, { ...profile, content: "principal engineer" }), embedding: { action: "clear" } },
        transaction,
      ),
    );
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);

    // And `findProfileRow` answers DETERMINISTICALLY rather than arbitrarily:
    // the order is total, so the same call returns the same row every time.
    const read = await harness.stores.memory.findProfileRow(
      chain.subject,
      {
        agentId: asMemoryIdentifier<AgentId>(chain.agentId),
        clusterId: asMemoryIdentifier<ClusterId>(chain.clusterId),
      },
      asMemoryIdentifier<ProfileKey>("role"),
    );
    const again = await harness.stores.memory.findProfileRow(
      chain.subject,
      {
        agentId: asMemoryIdentifier<AgentId>(chain.agentId),
        clusterId: asMemoryIdentifier<ClusterId>(chain.clusterId),
      },
      asMemoryIdentifier<ProfileKey>("role"),
    );
    expect(read.ok && again.ok).toBe(true);
    if (read.ok && again.ok) expect(read.value?.memoryId).toBe(again.value?.memoryId);
  });

  test("neither partial index exists in the database this repository builds", async () => {
    const indexes = await harness.base.client.$queryRaw<{ readonly indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'Memory'`;
    const names = indexes.map((index) => index.indexname);
    expect(names).not.toContain("Memory_profile_standalone_key");
    expect(names).not.toContain("Memory_profile_cluster_key");
    // The ones that DO exist, so the assertion above is about absence rather
    // than about a query that returned nothing.
    expect(names).toContain("Memory_environmentId_endUserId_sourceThreadId_contentHash_key");
  });
});
