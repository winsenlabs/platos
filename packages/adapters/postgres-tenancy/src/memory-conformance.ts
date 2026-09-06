// One scenario, written once, so this context's two in-memory doubles and this
// adapter can be asked the SAME questions and their answers compared.
//
// Same instrument as `./conformance.ts`, `./identity-conformance.ts` and
// `./governance-conformance.ts`, and the same reason: two independently written
// suites measure two things and agree by coincidence. This module drives one
// sequence of port calls and records what came back; a test runs it twice and
// compares verbatim. A divergence is then a named step with a value on each side.
//
// NO OBSERVATION CARRIES A MINTED INSTANT. Both stores are handed the SAME
// aggregates — `Memory`, `MemoryEntity` and `MemoryRelationship` all carry their
// own `createdAt` and `updatedAt`, so unlike `governance`'s five ports there is
// nothing for a store to mint. What is NOT compared is what PostgreSQL may
// nevertheless decide for itself: `Memory.updatedAt` is `@updatedAt`, so a
// delegate update stamps it whatever the aggregate said, and comparing it would
// measure the driver rather than the store. Every LIFECYCLE fact the scenario
// does compare is a boolean or a value the caller supplied.
//
// SCORES ARE NOT COMPARED; ORDERS ARE. `searchMemories` returns a cosine, and on
// one side it is computed by `cosineSimilarity` in JavaScript and on the other by
// pgvector in C over a `float4[]`. Two correct implementations of the same
// formula differ in the last bits, so the scenario records the ORDER of the ids
// and the length of the candidate list — which is what recall actually depends
// on — and the score bands are pinned against the real database separately.
//
// THE IDENTIFIERS ARE ALL UUIDS. `memoryFixture()` in the context's own
// `application/testing/fixtures.ts` mints `mem-1`, `agent-1` and `thread-1`;
// every one satisfies both doubles and every one is refused by `@db.Uuid`. The
// scenario is handed real ones by its environment, so a divergence here is a
// behaviour difference rather than a shape difference. The shape refusals have
// their own named cases in `memory-constraints.integration.test.ts`.
//
// FIVE THINGS ARE DELIBERATELY NOT IN THIS SCENARIO, because on each the double
// is WRONG rather than different, and a conformance run is for comparing answers.
// All five are pinned against the real database instead, and all five are
// reported:
//
//   A SECOND PROFILE ROW for one `(subject, ownership, profileKey)`.
//   `InMemoryMemoryRepository.insertMemory` refuses it. The migration that added
//   `profileKey` ends by saying the two partial unique indexes "are created by
//   MemoryProfileBackfillService" and does not create them, so PostgreSQL stores
//   it.
//
//   A SECOND ROW ON THE CONTENT IDENTITY WITH NO SOURCE THREAD. The double
//   compares `null === null` and refuses; the unique index treats NULLs as
//   distinct and PostgreSQL stores it.
//
//   `searchEntities` RETURNING ANYTHING. The double scores
//   `deterministicEmbedding(entity.label)` — a vector it invents from the row it
//   is scoring — and no method on `KnowledgeGraphRepository` can write
//   `MemoryEntity.embedding`, so the real store's candidate set is empty by
//   construction.
//
//   A THREE-COMPONENT VECTOR. `InMemoryEmbeddingModel` can be asked for one and
//   the double stores it; the column is `vector(1536)`.
//
//   `countTurnsInThread` WITH A REPEATED TURN ID. The double filters the list
//   and counts the duplicate twice; a `COUNT(*)` over `IN` counts rows.

import type {
  EnvironmentScope,
  KnowledgeGraphRepository,
  Memory,
  MemoryId,
  MemoryRepository,
  MemorySubject,
  Result,
  TransactionScope,
  AgentId,
  ClusterId,
  ContentHash,
  EndUserId,
  ProfileKey,
  ThreadId,
  TurnId,
} from "@platos/context-memory/application/ports/index.js";
import { asMemoryIdentifier, memorySubject } from "@platos/context-memory/application/ports/index.js";

import { runGraphConformance } from "./memory-conformance-graph.js";

/** Every identifier the scenario needs. All uuids; both stores use the same. */
export interface MemoryConformanceIds {
  readonly scope: EnvironmentScope;
  readonly endUserId: string;
  readonly agentId: string;
  readonly peerAgentId: string;
  readonly outsideAgentId: string;
  readonly clusterId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly secondTurnId: string;
  readonly ratingId: string;
  /** Three memory ids the scenario writes, in the order it writes them. */
  readonly memoryIds: readonly [string, string, string];
  /** Three entity ids and one edge id, for the graph half. */
  readonly entityIds: readonly [string, string, string];
  readonly relationshipId: string;
  /** A uuid of the right SHAPE that names no row, so a miss is a miss. */
  readonly absentId: string;
}

/** What one run of the scenario saw, keyed by step name. */
export type MemoryObservation = Record<string, unknown>;

/** The two ports, under the names the adapter and the doubles both use. */
export interface MemoryConformanceStores {
  readonly memory: MemoryRepository;
  readonly memoryGraph: KnowledgeGraphRepository;
}

/** Opening one transaction per step is the caller's job; both sides get the same one. */
export type ConformanceUnitOfWork = <Value>(
  work: (transaction: TransactionScope) => Promise<Value>,
) => Promise<Value>;

const HASH_EXTRACTED = "b".repeat(64);
const HASH_UNTHREADED = "c".repeat(64);
const AT = new Date("2026-05-01T09:00:00.000Z");

/** Advancing instants, so ascending `createdAt` is a total order on both sides. */
function stamps(): () => Date {
  let step = 0;
  return () => new Date(AT.getTime() + (step += 1) * 1000);
}

/** The failure code, never the message: two stores name the same fact differently. */
function outcome(result: Result<unknown>): string {
  return result.ok ? "ok" : result.error.code;
}

/** A memory read back, reduced to what BOTH stores can be asked for. */
function summary(memory: Memory): Record<string, unknown> {
  return {
    memoryId: memory.memoryId,
    kind: memory.kind,
    profileKey: memory.profileKey,
    content: memory.content,
    metadata: memory.metadata,
    visibility: memory.visibility,
    source: memory.source,
    contentHash: memory.contentHash,
    agentId: memory.ownership.agentId,
    clusterId: memory.ownership.clusterId,
    sourceThreadId: memory.provenance.sourceThreadId,
    sourceTurnIds: [...memory.provenance.sourceTurnIds],
    extractorVersion: memory.provenance.extractorVersion,
    confidence: memory.confidence.confidence,
    baseline: memory.confidence.feedbackBaselineConfidence,
    archived: memory.lifecycle.archivedAt !== null,
    quarantined: memory.lifecycle.quarantinedAt !== null,
    accessed: memory.lifecycle.lastAccessedAt !== null,
  };
}

function summaryOf(result: Result<Memory | null>): unknown {
  if (!result.ok) return outcome(result);
  return result.value === null ? null : summary(result.value);
}

function idsOf(result: Result<readonly Memory[]>): unknown {
  return result.ok ? result.value.map((memory) => memory.memoryId) : outcome(result);
}

export interface MemoryConformanceInput {
  readonly stores: MemoryConformanceStores;
  readonly ids: MemoryConformanceIds;
  readonly run: ConformanceUnitOfWork;
  /** A `vector(1536)` for `axis`. The harness and the doubles build it the same way. */
  readonly unitVector: (axis: number) => readonly number[];
}

export async function runMemoryConformance(
  input: MemoryConformanceInput,
): Promise<MemoryObservation> {
  const { stores, ids, run, unitVector } = input;
  const observed: MemoryObservation = {};
  const at = stamps();
  const subject: MemorySubject = memorySubject(ids.scope, asMemoryIdentifier<EndUserId>(ids.endUserId));
  const clusterAgents = [
    asMemoryIdentifier<AgentId>(ids.agentId),
    asMemoryIdentifier<AgentId>(ids.peerAgentId),
  ];
  const [manualId, extractedId, profileId] = ids.memoryIds;

  function draft(memoryId: string, overrides: Partial<Memory>): Memory {
    const createdAt = at();
    return {
      memoryId: asMemoryIdentifier<MemoryId>(memoryId),
      subject,
      ownership: {
        agentId: asMemoryIdentifier<AgentId>(ids.agentId),
        clusterId: asMemoryIdentifier<ClusterId>(ids.clusterId),
      },
      kind: "fact",
      profileKey: null,
      content: "prefers to be called Sam",
      metadata: null,
      visibility: "agent_visible",
      source: "manual",
      contentHash: null,
      provenance: {
        sourceThreadId: null,
        sourceTurnIds: [],
        extractorVersion: null,
        originalSource: null,
        originalSourceThreadId: null,
        originalSourceTurnIds: [],
      },
      confidence: { confidence: null, feedbackBaselineConfidence: null },
      lifecycle: {
        lastAccessedAt: null,
        quarantinedAt: null,
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      ...overrides,
    };
  }

  // --- the peer reads: what every scope decision is made from ---------------

  const bindings = await stores.memory.listAgentBindings(ids.scope);
  observed["listAgentBindings"] = bindings.ok
    ? bindings.value.map((binding) => ({ agentId: binding.agentId, clusterId: binding.clusterId }))
    : outcome(bindings);

  const ownership = await stores.memory.findSourceThreadOwnership(
    ids.scope,
    asMemoryIdentifier<ThreadId>(ids.threadId),
  );
  observed["findSourceThreadOwnership"] = ownership.ok ? ownership.value : outcome(ownership);

  const absentThread = await stores.memory.findSourceThreadOwnership(
    ids.scope,
    asMemoryIdentifier<ThreadId>(ids.absentId),
  );
  observed["findSourceThreadOwnershipAbsent"] = absentThread.ok ? absentThread.value : outcome(absentThread);

  const turnCount = await stores.memory.countTurnsInThread(asMemoryIdentifier<ThreadId>(ids.threadId), [
    asMemoryIdentifier<TurnId>(ids.turnId),
    asMemoryIdentifier<TurnId>(ids.secondTurnId),
  ]);
  observed["countTurnsInThread"] = turnCount.ok ? turnCount.value : outcome(turnCount);

  const foreignTurns = await stores.memory.countTurnsInThread(
    asMemoryIdentifier<ThreadId>(ids.threadId),
    [asMemoryIdentifier<TurnId>(ids.absentId)],
  );
  observed["countTurnsInThreadForeign"] = foreignTurns.ok ? foreignTurns.value : outcome(foreignTurns);

  // --- the three writes -----------------------------------------------------

  const manual = await run((transaction) =>
    stores.memory.insertMemory(
      { memory: draft(manualId, {}), embedding: { action: "set", vector: unitVector(3) } },
      transaction,
    ),
  );
  observed["insertManual"] = summaryOf(manual);

  const extracted = await run((transaction) =>
    stores.memory.insertMemory(
      {
        memory: draft(extractedId, {
          kind: "event",
          content: "moved to Berlin in May",
          metadata: { at: "2026-05-01T00:00:00.000Z" },
          source: "extracted",
          contentHash: asMemoryIdentifier<ContentHash>(HASH_EXTRACTED),
          provenance: {
            sourceThreadId: asMemoryIdentifier<ThreadId>(ids.threadId),
            sourceTurnIds: [asMemoryIdentifier<TurnId>(ids.turnId)],
            extractorVersion: "extractor-v3",
            originalSource: null,
            originalSourceThreadId: null,
            originalSourceTurnIds: [],
          },
          confidence: { confidence: 0.8, feedbackBaselineConfidence: null },
        }),
        embedding: { action: "set", vector: unitVector(7) },
      },
      transaction,
    ),
  );
  observed["insertExtracted"] = summaryOf(extracted);

  // A profile is stored WITHOUT an embedding — `CLEAR_EMBEDDING` on an insert is
  // a directive with nothing to do, and that is exactly what makes the union's
  // third case observable: the row is never a search candidate below.
  const profile = await run((transaction) =>
    stores.memory.insertMemory(
      {
        memory: draft(profileId, {
          kind: "profile",
          profileKey: asMemoryIdentifier<ProfileKey>("role"),
          content: "staff engineer",
          visibility: "private",
        }),
        embedding: { action: "clear" },
      },
      transaction,
    ),
  );
  observed["insertProfile"] = summaryOf(profile);

  // --- the point reads ------------------------------------------------------

  observed["findMemoryInScope"] = summaryOf(
    await stores.memory.findMemory(subject, clusterAgents, asMemoryIdentifier<MemoryId>(manualId)),
  );
  observed["findMemoryOutsideAgent"] = summaryOf(
    await stores.memory.findMemory(
      subject,
      [asMemoryIdentifier<AgentId>(ids.outsideAgentId)],
      asMemoryIdentifier<MemoryId>(manualId),
    ),
  );
  observed["findMemoryAbsent"] = summaryOf(
    await stores.memory.findMemory(subject, clusterAgents, asMemoryIdentifier<MemoryId>(ids.absentId)),
  );

  observed["findByContentIdentity"] = summaryOf(
    await stores.memory.findByContentIdentity(
      subject,
      asMemoryIdentifier<ThreadId>(ids.threadId),
      asMemoryIdentifier<ContentHash>(HASH_EXTRACTED),
    ),
  );
  observed["findByContentIdentityUnthreaded"] = summaryOf(
    await stores.memory.findByContentIdentity(
      subject,
      null,
      asMemoryIdentifier<ContentHash>(HASH_UNTHREADED),
    ),
  );

  observed["findProfileRow"] = summaryOf(
    await stores.memory.findProfileRow(
      subject,
      {
        agentId: asMemoryIdentifier<AgentId>(ids.agentId),
        clusterId: asMemoryIdentifier<ClusterId>(ids.clusterId),
      },
      asMemoryIdentifier<ProfileKey>("role"),
    ),
  );
  // THE PEER AGENT'S PROBE IS THE ONE THAT SEPARATES THE TWO OWNERSHIP DOMAINS.
  // The row was written by `agentId` under `clusterId`, and a CLUSTERED profile
  // is one row for the whole cluster — so `peerAgentId`, which is bound into the
  // same cluster, must find it. A store that keyed the lookup on the agent alone
  // answers both this step and the one below correctly for the writing agent and
  // wrongly for every other member of its cluster.
  observed["findProfileRowFromPeer"] = summaryOf(
    await stores.memory.findProfileRow(
      subject,
      {
        agentId: asMemoryIdentifier<AgentId>(ids.peerAgentId),
        clusterId: asMemoryIdentifier<ClusterId>(ids.clusterId),
      },
      asMemoryIdentifier<ProfileKey>("role"),
    ),
  );
  observed["findProfileRowOtherOwner"] = summaryOf(
    await stores.memory.findProfileRow(
      subject,
      { agentId: asMemoryIdentifier<AgentId>(ids.outsideAgentId), clusterId: null },
      asMemoryIdentifier<ProfileKey>("role"),
    ),
  );

  // --- the set reads --------------------------------------------------------

  const allFilter = {
    subject,
    agentIds: clusterAgents,
    kind: null,
    source: null,
    visibilities: [],
    archiveState: "all" as const,
    excludeRag: false,
    excludeQuarantined: false,
  };

  observed["listMemories"] = idsOf(await stores.memory.listMemories(allFilter, 10, 0));
  observed["listMemoriesOffset"] = idsOf(await stores.memory.listMemories(allFilter, 10, 2));
  observed["listMemoriesNoAgent"] = idsOf(
    await stores.memory.listMemories({ ...allFilter, agentIds: [] }, 10, 0),
  );
  observed["listMemoriesRecallOnly"] = idsOf(
    await stores.memory.listMemories(
      { ...allFilter, visibilities: ["agent_visible"], archiveState: "active" },
      10,
      0,
    ),
  );
  observed["listMemoriesByKind"] = idsOf(
    await stores.memory.listMemories({ ...allFilter, kind: "profile" }, 10, 0),
  );

  const page = await stores.memory.pageMemories(allFilter, 2, 0);
  observed["pageMemories"] = page.ok
    ? { items: page.value.items.map((memory) => memory.memoryId), total: page.value.total }
    : outcome(page);

  const exportFirst = await stores.memory.listExportPage(allFilter, null, 2);
  observed["listExportPage"] = exportFirst.ok
    ? { items: exportFirst.value.items.map((memory) => memory.memoryId), cursor: exportFirst.value.nextCursor }
    : outcome(exportFirst);

  const cursor = exportFirst.ok ? exportFirst.value.nextCursor : null;
  const exportSecond = await stores.memory.listExportPage(allFilter, cursor, 2);
  observed["listExportPageResume"] = exportSecond.ok
    ? { items: exportSecond.value.items.map((memory) => memory.memoryId), cursor: exportSecond.value.nextCursor }
    : outcome(exportSecond);

  // The ORDER, not the score. A profile has no vector, so it is absent from
  // every candidate list below — which is the rule "a profile is stored WITHOUT
  // an embedding" being observed rather than asserted.
  const search = await stores.memory.searchMemories({
    filter: allFilter,
    embedding: unitVector(7),
    candidateLimit: 10,
  });
  observed["searchMemories"] = search.ok
    ? search.value.map((match) => match.memory.memoryId)
    : outcome(search);
  observed["searchMemoriesTopIsNearest"] = search.ok ? (search.value[0]?.memory.memoryId ?? null) : outcome(search);

  const narrowedSearch = await stores.memory.searchMemories({
    filter: { ...allFilter, kind: "event" },
    embedding: unitVector(3),
    candidateLimit: 10,
  });
  observed["searchMemoriesNarrowed"] = narrowedSearch.ok
    ? narrowedSearch.value.map((match) => match.memory.memoryId)
    : outcome(narrowedSearch);

  // --- the lifecycle writes -------------------------------------------------

  const touched = await stores.memory.touchAccessed(
    ids.scope,
    [asMemoryIdentifier<MemoryId>(manualId), asMemoryIdentifier<MemoryId>(ids.absentId)],
    at(),
  );
  observed["touchAccessed"] = touched.ok ? touched.value : outcome(touched);
  observed["touchAccessedRead"] = summaryOf(
    await stores.memory.findMemory(subject, clusterAgents, asMemoryIdentifier<MemoryId>(manualId)),
  );

  const archived = await run((transaction) =>
    stores.memory.updateMemory(
      {
        memory: {
          ...draft(manualId, {}),
          lifecycle: {
            lastAccessedAt: null,
            quarantinedAt: null,
            archivedAt: at(),
            createdAt: AT,
            updatedAt: at(),
          },
        },
        embedding: { action: "keep" },
      },
      transaction,
    ),
  );
  observed["updateMemoryArchived"] = summaryOf(archived);
  observed["listMemoriesActiveAfterArchive"] = idsOf(
    await stores.memory.listMemories({ ...allFilter, archiveState: "active" }, 10, 0),
  );
  observed["listMemoriesArchivedAfterArchive"] = idsOf(
    await stores.memory.listMemories({ ...allFilter, archiveState: "archived" }, 10, 0),
  );

  // --- feedback -------------------------------------------------------------

  const revision = await stores.memory.findRatingRevision(ids.ratingId);
  observed["findRatingRevision"] = revision.ok
    ? revision.value === null
      ? null
      : {
          environmentId: revision.value.environment.environmentId,
          projectId: revision.value.environment.projectId,
          organizationId: revision.value.environment.organizationId,
          endUserId: revision.value.endUserId,
          turnId: revision.value.turnId,
          revision: revision.value.revision,
        }
    : outcome(revision);

  const absentRevision = await stores.memory.findRatingRevision(ids.absentId);
  observed["findRatingRevisionAbsent"] = absentRevision.ok ? absentRevision.value : outcome(absentRevision);

  const ratings = await stores.memory.listRatingsForTurns(
    ids.scope,
    asMemoryIdentifier<EndUserId>(ids.endUserId),
    [asMemoryIdentifier<TurnId>(ids.turnId), asMemoryIdentifier<TurnId>(ids.secondTurnId)],
  );
  observed["listRatingsForTurns"] = ratings.ok
    ? ratings.value.map((rating) => ({ turnId: rating.turnId, rating: rating.rating }))
    : outcome(ratings);

  observed["listMemoriesForSourceTurn"] = idsOf(
    await stores.memory.listMemoriesForSourceTurn(
      ids.scope,
      asMemoryIdentifier<EndUserId>(ids.endUserId),
      asMemoryIdentifier<TurnId>(ids.turnId),
    ),
  );

  const reconciled = await run((transaction) =>
    stores.memory.applyReconciledConfidence(
      asMemoryIdentifier<MemoryId>(extractedId),
      { baseline: 0.8, confidence: 0.5, quarantinedAt: at() },
      transaction,
    ),
  );
  observed["applyReconciledConfidence"] = outcome(reconciled);
  observed["applyReconciledConfidenceRead"] = summaryOf(
    await stores.memory.findMemory(subject, clusterAgents, asMemoryIdentifier<MemoryId>(extractedId)),
  );
  observed["listMemoriesExcludingQuarantined"] = idsOf(
    await stores.memory.listMemories({ ...allFilter, excludeQuarantined: true }, 10, 0),
  );

  // --- the graph half, into the SAME observation map ------------------------

  await runGraphConformance({ stores, ids, run, subject, at, observed });

  // --- deletion and erasure, last because both destroy ----------------------

  const wrongAgent = await run((transaction) =>
    stores.memory.deleteMemories(
      subject,
      [asMemoryIdentifier<AgentId>(ids.outsideAgentId)],
      [asMemoryIdentifier<MemoryId>(manualId)],
      transaction,
    ),
  );
  observed["deleteMemoriesWrongAgent"] = wrongAgent.ok ? wrongAgent.value : outcome(wrongAgent);

  const deleted = await run((transaction) =>
    stores.memory.deleteMemories(
      subject,
      clusterAgents,
      [asMemoryIdentifier<MemoryId>(manualId), asMemoryIdentifier<MemoryId>(ids.absentId)],
      transaction,
    ),
  );
  observed["deleteMemories"] = deleted.ok ? deleted.value : outcome(deleted);

  const selector = { environment: ids.scope, endUserId: asMemoryIdentifier<EndUserId>(ids.endUserId) };
  const subjectless = { environment: ids.scope, endUserId: null };

  const count = await stores.memory.countMemoriesForSubject(selector);
  observed["countMemoriesForSubject"] = count.ok ? count.value : outcome(count);
  const countNone = await stores.memory.countMemoriesForSubject(subjectless);
  observed["countMemoriesForSubjectSubjectless"] = countNone.ok ? countNone.value : outcome(countNone);

  const erasedNone = await run((transaction) =>
    stores.memory.deleteMemoriesForSubject(subjectless, transaction),
  );
  observed["deleteMemoriesForSubjectSubjectless"] = erasedNone.ok ? erasedNone.value : outcome(erasedNone);

  const erased = await run((transaction) => stores.memory.deleteMemoriesForSubject(selector, transaction));
  observed["deleteMemoriesForSubject"] = erased.ok ? erased.value : outcome(erased);

  const afterErasure = await stores.memory.countMemoriesForSubject(selector);
  observed["countMemoriesAfterErasure"] = afterErasure.ok ? afterErasure.value : outcome(afterErasure);

  return observed;
}
