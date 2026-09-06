// Use cases: write the knowledge graph.
//
// Two writes — upsert a node, assert an edge — and both are idempotent, because
// both are on the extraction path and extraction runs repeatedly over
// overlapping windows of the same conversation. An upsert that appended would
// give a subject forty nodes for one person; an edge assertion that appended
// would give them forty identical edges.
//
// THE NODE'S OWNERSHIP FOLLOWS THE WRITING AGENT'S BINDING, NOT THE CALLER'S
// REQUEST. `resolveWriteScope` decides which agent a write is attributed to and
// `planEntityUpsert` decides what happens given what is already stored — the
// three-case rule, including the conflict it refuses, is in the domain
// (`domain/entity.ts`) so it is exercisable without a store.
//
// AN EDGE IS CHECKED AT BOTH ENDS, AND THE CHECK IS AGAINST WHAT IS STORED. Both
// endpoints are read back inside the caller's agent scope before the edge is
// admitted, so a caller cannot join a node it can see to one it cannot: the
// unreadable endpoint simply is not found. Then `admitRelationship` requires the
// two to share an agent scope, which is what stops an agent inside a cluster from
// joining a cluster node to its own private one and reading the private node out
// through the cluster's traversal.

import { asIdentifier, err, ok, runResult, type Result } from "@platos/kernel";

import {
  admitEntityKey,
  admitRelationship,
  applyEntityDraft,
  clusterPeers,
  DEFAULT_ENTITY_TYPE,
  entityNotFound,
  mergeAliases,
  planEntityUpsert,
  promoteEntity,
  reassertRelationship,
  relationshipIdentity,
  type AgentId,
  type EndUserId,
  type EntityKey,
  type MemoryEntity,
  type MemoryEntityId,
  type MemoryId,
  type MemoryMetadata,
  type MemoryRelationship,
  type MemoryRelationshipId,
  type ThreadId,
} from "../domain/index.js";
import { authorizeMutation, authorizeWrite, type WriteScope } from "./authorization.js";
import type { MemoryDependencies } from "./dependencies.js";
import { embedQuery } from "./embedding.js";

export interface RememberEntityCommand {
  readonly authorization: unknown;
  /** Required under an operator grant; a runtime grant names its own subject. */
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
  readonly requestedAgentId: AgentId | null;
  /** The slug, or the display name it is derived from. */
  readonly entityKey: string;
  readonly entityType?: string;
  readonly label?: string;
  readonly aliases?: readonly string[];
  readonly metadata?: MemoryMetadata;
}

export interface RelateEntitiesCommand {
  readonly authorization: unknown;
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
  readonly requestedAgentId: AgentId | null;
  readonly fromEntityId: MemoryEntityId;
  readonly toEntityId: MemoryEntityId;
  readonly relationshipType: string;
  readonly weight?: number | null;
  readonly metadata?: MemoryMetadata;
  readonly sourceMemoryId?: MemoryId | null;
}

export interface ForgetEntityCommand {
  readonly authorization: unknown;
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
  readonly entityId: MemoryEntityId;
}

/** Whether a node was created, folded onto, or moved into a cluster. */
export interface EntityUpsertReport {
  readonly entity: MemoryEntity;
  readonly outcome: "created" | "updated" | "promoted";
}

export async function rememberEntity(
  dependencies: MemoryDependencies,
  command: RememberEntityCommand,
): Promise<Result<EntityUpsertReport>> {
  const key = admitEntityKey(command.entityKey);
  if (!key.ok) return err(key.error);

  const scope = await authorizeWrite(dependencies, {
    authorization: command.authorization,
    endUserId: command.endUserId,
    actingAgentId: command.actingAgentId,
    requestedAgentId: command.requestedAgentId,
    sourceThreadId: null as ThreadId | null,
  });
  if (!scope.ok) return err(scope.error);

  const candidates = await dependencies.graph.findEntityCandidates(
    scope.value.subject,
    scope.value.binding,
    key.value,
  );
  if (!candidates.ok) return err(candidates.error);

  const draft = {
    entityKey: key.value,
    entityType: command.entityType,
    label: command.label,
    aliases: command.aliases,
    metadata: command.metadata,
  };
  const plan = planEntityUpsert(scope.value.binding, candidates.value, draft);
  if (!plan.ok) return err(plan.error);

  const now = dependencies.clock.now();
  if (plan.value.action === "create") {
    const created = buildEntity(dependencies, scope.value, key.value, command, now);
    const embedding = await embedQuery(dependencies, created.label);
    if (!embedding.ok) return err(embedding.error);
    return runResult(dependencies.unitOfWork, async (transaction) => {
      const written = await dependencies.graph.insertEntity(created, transaction);
      if (!written.ok) return err(written.error);
      return ok({ entity: written.value, outcome: "created" as const });
    });
  }

  const folded =
    plan.value.action === "promote"
      ? promoteEntity(plan.value.entity, scope.value.binding, draft, now)
      : applyEntityDraft(plan.value.entity, draft, now);
  const outcome = plan.value.action === "promote" ? ("promoted" as const) : ("updated" as const);
  return runResult(dependencies.unitOfWork, async (transaction) => {
    const written = await dependencies.graph.updateEntity(folded, transaction);
    if (!written.ok) return err(written.error);
    return ok({ entity: written.value, outcome });
  });
}

export async function relateEntities(
  dependencies: MemoryDependencies,
  command: RelateEntitiesCommand,
): Promise<Result<MemoryRelationship>> {
  const scope = await authorizeWrite(dependencies, {
    authorization: command.authorization,
    endUserId: command.endUserId,
    actingAgentId: command.actingAgentId,
    requestedAgentId: command.requestedAgentId,
    sourceThreadId: null as ThreadId | null,
  });
  if (!scope.ok) return err(scope.error);

  // Both endpoints are read across the writing agent's WHOLE cluster, because a
  // clustered node may be owned by any member. `admitRelationship` then still
  // requires the two to share a scope, which is the invariant; this is only what
  // the caller is allowed to SEE while the edge is being checked.
  const readable = clusterPeers(scope.value.bindings, scope.value.binding).map(
    (binding) => binding.agentId,
  );
  const endpoints = await dependencies.graph.listEntitiesByIds(scope.value.subject, readable, [
    command.fromEntityId,
    command.toEntityId,
  ]);
  if (!endpoints.ok) return err(endpoints.error);

  const from = endpoints.value.find((entity) => entity.entityId === command.fromEntityId);
  const to = endpoints.value.find((entity) => entity.entityId === command.toEntityId);
  if (from === undefined) return err(entityNotFound(command.fromEntityId));
  if (to === undefined) return err(entityNotFound(command.toEntityId));

  const admitted = admitRelationship(
    {
      fromEntityId: command.fromEntityId,
      toEntityId: command.toEntityId,
      relationshipType: command.relationshipType,
      weight: command.weight,
      metadata: command.metadata,
      sourceMemoryId: command.sourceMemoryId,
    },
    from.ownership,
    to.ownership,
  );
  if (!admitted.ok) return err(admitted.error);

  const existing = await dependencies.graph.findRelationship(
    scope.value.subject,
    relationshipIdentity(admitted.value),
  );
  if (!existing.ok) return err(existing.error);

  return runResult(dependencies.unitOfWork, async (transaction) => {
    if (existing.value !== null) {
      return dependencies.graph.updateRelationship(
        reassertRelationship(existing.value, admitted.value),
        transaction,
      );
    }
    return dependencies.graph.insertRelationship(
      {
        relationshipId: asIdentifier<MemoryRelationshipId>(dependencies.ids.uuid()),
        subject: scope.value.subject,
        ownership: scope.value.binding,
        fromEntityId: admitted.value.fromEntityId,
        toEntityId: admitted.value.toEntityId,
        relationshipType: admitted.value.relationshipType,
        weight: admitted.value.weight ?? null,
        metadata: admitted.value.metadata ?? null,
        sourceMemoryId: admitted.value.sourceMemoryId ?? null,
        createdAt: dependencies.clock.now(),
      },
      transaction,
    );
  });
}

/**
 * Remove a node.
 *
 * Its edges go with it — the schema cascades from both endpoints — which is why
 * there is no `forgetRelationship` beside this: an edge whose endpoint is gone
 * is not a fact anybody can read, and leaving it would leave a dangling half of
 * a relationship the traversal would then have to filter on every hop.
 */
export async function forgetEntity(
  dependencies: MemoryDependencies,
  command: ForgetEntityCommand,
): Promise<Result<boolean>> {
  const scope = await authorizeMutation(dependencies, { ...command, requestedAgentIds: [] });
  if (!scope.ok) return err(scope.error);
  return runResult(dependencies.unitOfWork, async (transaction) =>
    dependencies.graph.deleteEntity(
      scope.value.subject,
      scope.value.agentIds,
      command.entityId,
      transaction,
    ),
  );
}

function buildEntity(
  dependencies: MemoryDependencies,
  scope: WriteScope,
  entityKey: EntityKey,
  command: RememberEntityCommand,
  now: Date,
): MemoryEntity {
  return {
    entityId: asIdentifier<MemoryEntityId>(dependencies.ids.uuid()),
    subject: scope.subject,
    ownership: scope.binding,
    entityKey,
    entityType: command.entityType ?? DEFAULT_ENTITY_TYPE,
    // The slug is the fallback label, not the empty string: a node with no
    // display name renders as its key, which is at least readable.
    label: command.label ?? entityKey,
    aliases: mergeAliases([], command.aliases ?? []),
    metadata: command.metadata ?? null,
    createdAt: now,
    updatedAt: now,
  };
}
