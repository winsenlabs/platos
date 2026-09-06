// The graph half of the shared scenario: `MemoryEntity` and `MemoryRelationship`.
//
// It is a second FILE and not a second SCENARIO. Every step below writes into the
// SAME observation map its caller opened, so the differential still compares one
// object per store and a divergence still names one step. The split is the
// §6 file budget pointing at the seam the two ports already have — one is the
// write path of every remembered fact, the other the write path of extraction —
// and `governance-conformance-evals.ts` is the same shape for the same reason.
//
// THE TWO OWNERSHIP DOMAINS ARE THE POINT OF THE ENTITY STEPS. A node is
// identified either by `(environment, subject, cluster, key)` or by
// `(environment, subject, agent, key)`, never by both, and the schema says so
// with TWO PARTIAL UNIQUE INDEXES that Prisma cannot express. So the scenario
// writes the SAME `entityKey` twice — once clustered and once standalone under
// an agent in no cluster — and asks `findEntityCandidates` from each side. A
// store that had collapsed the two indexes into one would refuse the second
// write; a store that had ignored ownership would answer both slots with one row.
//
// `searchEntities` IS DELIBERATELY ABSENT, and its absence is the finding. No
// method on `KnowledgeGraphRepository` can write `MemoryEntity.embedding`:
// `insertEntity` takes a `MemoryEntity`, which carries no vector, and there is
// no `EntityWrite` to pair one with. The real store's candidate set is therefore
// empty for every node this port has ever written, while
// `InMemoryKnowledgeGraphRepository` scores `deterministicEmbedding(entity.label)`
// — a vector it invents at query time from the row it is scoring. Comparing them
// would compare a store against a double that is answering a different question.
// `memory-rules.integration.test.ts` pins both halves of it against the database.

import type {
  AgentId,
  ClusterId,
  EndUserId,
  EntityKey,
  MemoryEntity,
  MemoryEntityId,
  MemoryRelationship,
  MemoryRelationshipId,
  MemorySubject,
  Result,
} from "@platos/context-memory/application/ports/index.js";
import { asMemoryIdentifier } from "@platos/context-memory/application/ports/index.js";

import type {
  ConformanceUnitOfWork,
  MemoryConformanceIds,
  MemoryConformanceStores,
  MemoryObservation,
} from "./memory-conformance.js";

function outcome(result: Result<unknown>): string {
  return result.ok ? "ok" : result.error.code;
}

function entitySummary(entity: MemoryEntity): Record<string, unknown> {
  return {
    entityId: entity.entityId,
    entityKey: entity.entityKey,
    entityType: entity.entityType,
    label: entity.label,
    aliases: [...entity.aliases],
    metadata: entity.metadata,
    agentId: entity.ownership.agentId,
    clusterId: entity.ownership.clusterId,
  };
}

function entityOf(result: Result<MemoryEntity | null>): unknown {
  if (!result.ok) return outcome(result);
  return result.value === null ? null : entitySummary(result.value);
}

function edgeSummary(edge: MemoryRelationship): Record<string, unknown> {
  return {
    relationshipId: edge.relationshipId,
    fromEntityId: edge.fromEntityId,
    toEntityId: edge.toEntityId,
    relationshipType: edge.relationshipType,
    weight: edge.weight,
    metadata: edge.metadata,
    sourceMemoryId: edge.sourceMemoryId,
    agentId: edge.ownership.agentId,
    clusterId: edge.ownership.clusterId,
  };
}

function edgeOf(result: Result<MemoryRelationship | null>): unknown {
  if (!result.ok) return outcome(result);
  return result.value === null ? null : edgeSummary(result.value);
}

export interface GraphConformanceInput {
  readonly stores: MemoryConformanceStores;
  readonly ids: MemoryConformanceIds;
  readonly run: ConformanceUnitOfWork;
  readonly subject: MemorySubject;
  readonly at: () => Date;
  readonly observed: MemoryObservation;
}

export async function runGraphConformance(input: GraphConformanceInput): Promise<void> {
  const { stores, ids, run, subject, at, observed } = input;
  const graph = stores.memoryGraph;
  const [clusteredId, peerId, standaloneId] = ids.entityIds;
  const clusterAgents = [
    asMemoryIdentifier<AgentId>(ids.agentId),
    asMemoryIdentifier<AgentId>(ids.peerAgentId),
  ];
  const clusteredOwner = {
    agentId: asMemoryIdentifier<AgentId>(ids.agentId),
    clusterId: asMemoryIdentifier<ClusterId>(ids.clusterId),
  };
  const standaloneOwner = {
    agentId: asMemoryIdentifier<AgentId>(ids.outsideAgentId),
    clusterId: null,
  };
  const SHARED_KEY = asMemoryIdentifier<EntityKey>("acme-corp");

  function entityDraft(
    entityId: string,
    overrides: Partial<MemoryEntity> = {},
  ): MemoryEntity {
    const createdAt = at();
    return {
      entityId: asMemoryIdentifier<MemoryEntityId>(entityId),
      subject,
      ownership: clusteredOwner,
      entityKey: SHARED_KEY,
      entityType: "org",
      label: "Acme Corp",
      aliases: [],
      metadata: null,
      createdAt,
      updatedAt: createdAt,
      ...overrides,
    };
  }

  const emptyCandidates = await graph.findEntityCandidates(subject, clusteredOwner, SHARED_KEY);
  observed["findEntityCandidatesEmpty"] = emptyCandidates.ok
    ? { clustered: emptyCandidates.value.clustered, standalone: emptyCandidates.value.standalone }
    : outcome(emptyCandidates);

  const clustered = await run((transaction) =>
    graph.insertEntity(entityDraft(clusteredId, { metadata: { confidence: "high" } }), transaction),
  );
  observed["insertEntityClustered"] = clustered.ok ? entitySummary(clustered.value) : outcome(clustered);

  const peer = await run((transaction) =>
    graph.insertEntity(
      entityDraft(peerId, {
        ownership: {
          agentId: asMemoryIdentifier<AgentId>(ids.peerAgentId),
          clusterId: asMemoryIdentifier<ClusterId>(ids.clusterId),
        },
        entityKey: asMemoryIdentifier<EntityKey>("berlin"),
        entityType: "location",
        label: "Berlin",
        aliases: ["BER"],
      }),
      transaction,
    ),
  );
  observed["insertEntityPeer"] = peer.ok ? entitySummary(peer.value) : outcome(peer);

  // The SAME key again, under an agent in no cluster. Two partial unique
  // indexes, two identity domains, one key.
  const standalone = await run((transaction) =>
    graph.insertEntity(
      entityDraft(standaloneId, { ownership: standaloneOwner, label: "ACME Corporation" }),
      transaction,
    ),
  );
  observed["insertEntityStandalone"] = standalone.ok ? entitySummary(standalone.value) : outcome(standalone);

  const clusteredCandidates = await graph.findEntityCandidates(subject, clusteredOwner, SHARED_KEY);
  observed["findEntityCandidatesClustered"] = clusteredCandidates.ok
    ? {
        clustered: clusteredCandidates.value.clustered?.entityId ?? null,
        standalone: clusteredCandidates.value.standalone?.entityId ?? null,
      }
    : outcome(clusteredCandidates);

  const standaloneCandidates = await graph.findEntityCandidates(subject, standaloneOwner, SHARED_KEY);
  observed["findEntityCandidatesStandalone"] = standaloneCandidates.ok
    ? {
        clustered: standaloneCandidates.value.clustered?.entityId ?? null,
        standalone: standaloneCandidates.value.standalone?.entityId ?? null,
      }
    : outcome(standaloneCandidates);

  observed["findEntityInScope"] = entityOf(
    await graph.findEntity(subject, clusterAgents, asMemoryIdentifier<MemoryEntityId>(clusteredId)),
  );
  observed["findEntityOutsideAgent"] = entityOf(
    await graph.findEntity(
      subject,
      [asMemoryIdentifier<AgentId>(ids.outsideAgentId)],
      asMemoryIdentifier<MemoryEntityId>(clusteredId),
    ),
  );
  observed["findEntityAbsent"] = entityOf(
    await graph.findEntity(subject, clusterAgents, asMemoryIdentifier<MemoryEntityId>(ids.absentId)),
  );

  // The CALLER'S order, not the table's: a traversal hands this method the ids it
  // just collected and walks the answer.
  const byIds = await graph.listEntitiesByIds(subject, clusterAgents, [
    asMemoryIdentifier<MemoryEntityId>(peerId),
    asMemoryIdentifier<MemoryEntityId>(ids.absentId),
    asMemoryIdentifier<MemoryEntityId>(clusteredId),
  ]);
  observed["listEntitiesByIds"] = byIds.ok
    ? byIds.value.map((entity) => entity.entityId)
    : outcome(byIds);

  const listed = await graph.listEntities(subject, clusterAgents, 10, 0);
  observed["listEntities"] = listed.ok
    ? { items: listed.value.items.map((entity) => entity.entityId), total: listed.value.total }
    : outcome(listed);

  const listedOutside = await graph.listEntities(
    subject,
    [asMemoryIdentifier<AgentId>(ids.outsideAgentId)],
    10,
    0,
  );
  observed["listEntitiesOutside"] = listedOutside.ok
    ? { items: listedOutside.value.items.map((entity) => entity.entityId), total: listedOutside.value.total }
    : outcome(listedOutside);

  const renamed = await run((transaction) =>
    graph.updateEntity(
      entityDraft(clusteredId, {
        label: "Acme Corporation",
        aliases: ["Acme", "ACME"],
        metadata: { confidence: "medium" },
      }),
      transaction,
    ),
  );
  observed["updateEntity"] = renamed.ok ? entitySummary(renamed.value) : outcome(renamed);
  observed["updateEntityRead"] = entityOf(
    await graph.findEntity(subject, clusterAgents, asMemoryIdentifier<MemoryEntityId>(clusteredId)),
  );

  // --- edges ----------------------------------------------------------------

  function edgeDraft(overrides: Partial<MemoryRelationship> = {}): MemoryRelationship {
    return {
      relationshipId: asMemoryIdentifier<MemoryRelationshipId>(ids.relationshipId),
      subject,
      ownership: clusteredOwner,
      fromEntityId: asMemoryIdentifier<MemoryEntityId>(clusteredId),
      toEntityId: asMemoryIdentifier<MemoryEntityId>(peerId),
      relationshipType: "works_at",
      weight: null,
      metadata: null,
      sourceMemoryId: null,
      createdAt: at(),
      ...overrides,
    };
  }

  const edge = await run((transaction) => graph.insertRelationship(edgeDraft(), transaction));
  observed["insertRelationship"] = edge.ok ? edgeSummary(edge.value) : outcome(edge);

  // The unique on `(from, to, type)` is what makes `relateEntities` idempotent,
  // and an assertion that it is would be vacuous against a store that permitted
  // duplicates. The CODE is compared and the message is not: two stores name the
  // same fact in their own words.
  const duplicate = await run((transaction) =>
    graph.insertRelationship(
      edgeDraft({ relationshipId: asMemoryIdentifier<MemoryRelationshipId>(ids.absentId) }),
      transaction,
    ),
  );
  observed["insertRelationshipDuplicate"] = outcome(duplicate);

  observed["findRelationship"] = edgeOf(
    await graph.findRelationship(subject, {
      fromEntityId: asMemoryIdentifier<MemoryEntityId>(clusteredId),
      toEntityId: asMemoryIdentifier<MemoryEntityId>(peerId),
      relationshipType: "works_at",
    }),
  );
  observed["findRelationshipReversed"] = edgeOf(
    await graph.findRelationship(subject, {
      fromEntityId: asMemoryIdentifier<MemoryEntityId>(peerId),
      toEntityId: asMemoryIdentifier<MemoryEntityId>(clusteredId),
      relationshipType: "works_at",
    }),
  );

  const weighted = await run((transaction) =>
    graph.updateRelationship(edgeDraft({ weight: 0.75, metadata: { source: "extraction" } }), transaction),
  );
  observed["updateRelationship"] = weighted.ok ? edgeSummary(weighted.value) : outcome(weighted);

  const incident = await graph.listIncidentRelationships(subject, clusterAgents, [
    asMemoryIdentifier<MemoryEntityId>(clusteredId),
  ]);
  observed["listIncidentRelationships"] = incident.ok
    ? incident.value.map((relationship) => relationship.relationshipId)
    : outcome(incident);

  const incidentReversed = await graph.listIncidentRelationships(subject, clusterAgents, [
    asMemoryIdentifier<MemoryEntityId>(peerId),
  ]);
  observed["listIncidentRelationshipsReversed"] = incidentReversed.ok
    ? incidentReversed.value.map((relationship) => relationship.relationshipId)
    : outcome(incidentReversed);

  const incidentOutside = await graph.listIncidentRelationships(
    subject,
    [asMemoryIdentifier<AgentId>(ids.outsideAgentId)],
    [asMemoryIdentifier<MemoryEntityId>(clusteredId)],
  );
  observed["listIncidentRelationshipsOutside"] = incidentOutside.ok
    ? incidentOutside.value.map((relationship) => relationship.relationshipId)
    : outcome(incidentOutside);

  // --- counts, then destruction ---------------------------------------------

  const selector = { environment: ids.scope, endUserId: asMemoryIdentifier<EndUserId>(ids.endUserId) };
  const subjectless = { environment: ids.scope, endUserId: null };

  const entityCount = await graph.countEntitiesForSubject(selector);
  observed["countEntitiesForSubject"] = entityCount.ok ? entityCount.value : outcome(entityCount);
  const edgeCount = await graph.countRelationshipsForSubject(selector);
  observed["countRelationshipsForSubject"] = edgeCount.ok ? edgeCount.value : outcome(edgeCount);
  const subjectlessEntities = await graph.countEntitiesForSubject(subjectless);
  observed["countEntitiesSubjectless"] = subjectlessEntities.ok
    ? subjectlessEntities.value
    : outcome(subjectlessEntities);

  const refusedDelete = await run((transaction) =>
    graph.deleteEntity(
      subject,
      [asMemoryIdentifier<AgentId>(ids.outsideAgentId)],
      asMemoryIdentifier<MemoryEntityId>(clusteredId),
      transaction,
    ),
  );
  observed["deleteEntityWrongAgent"] = refusedDelete.ok ? refusedDelete.value : outcome(refusedDelete);

  const removedStandalone = await run((transaction) =>
    graph.deleteEntity(
      subject,
      [asMemoryIdentifier<AgentId>(ids.outsideAgentId)],
      asMemoryIdentifier<MemoryEntityId>(standaloneId),
      transaction,
    ),
  );
  observed["deleteEntity"] = removedStandalone.ok ? removedStandalone.value : outcome(removedStandalone);

  const erasedEdges = await run((transaction) =>
    graph.deleteRelationshipsForSubject(selector, transaction),
  );
  observed["deleteRelationshipsForSubject"] = erasedEdges.ok ? erasedEdges.value : outcome(erasedEdges);

  const erasedEntities = await run((transaction) =>
    graph.deleteEntitiesForSubject(selector, transaction),
  );
  observed["deleteEntitiesForSubject"] = erasedEntities.ok ? erasedEntities.value : outcome(erasedEntities);

  const afterEntities = await graph.countEntitiesForSubject(selector);
  observed["countEntitiesAfterErasure"] = afterEntities.ok ? afterEntities.value : outcome(afterEntities);
  const afterEdges = await graph.countRelationshipsForSubject(selector);
  observed["countRelationshipsAfterErasure"] = afterEdges.ok ? afterEdges.value : outcome(afterEdges);
}
