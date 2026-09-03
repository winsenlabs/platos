// Use cases: agent clusters.
//
// A CLUSTER OWNS NO MEMBERSHIP ROWS. Membership IS `AgentBinding.clusterId`, so
// every join and leave is a binding write, and every membership read is a
// binding read. That is why joining an agent to a cluster and removing it again
// both go through `AgentsRepository` rather than through anything cluster-shaped:
// there is nothing else to write.
//
// AND THAT IS WHY DELETING A CLUSTER IS TWO WRITES. The members are detached
// first, then the row goes. Relying on the foreign key's own on-delete behaviour
// would work — it nulls the column — but it would do it silently and outside the
// transaction's own vocabulary, and a store configured differently would orphan
// every member instead. Detaching explicitly makes the behaviour the domain's.
//
// THE PRIMARY AGENT IS A KEY INSIDE FREE-FORM JSON AND ITS THREE RULES ARE IN
// `domain/cluster.ts`. This file's job is to apply them at the right moments:
// elect on the first join, re-elect on the primary's departure, and clear the
// key when the last member leaves.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  admitCluster,
  admitSlug,
  applyClusterPatch,
  asAgentsIdentifier,
  byClusterOrder,
  clusterAlreadyExists,
  clusterNotFound,
  clusterSlugIsTaken,
  electOnJoin,
  electOnLeave,
  assignCluster,
  resolveSlug,
  type AgentCluster,
  type AgentClusterId,
  type AgentId,
  type ClusterPatch,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { AgentsDependencies } from "./dependencies.js";
import { requireBound } from "./read-agents.js";

export interface ClusterQuery {
  readonly authorization: unknown;
}

export interface DescribeClusterQuery extends ClusterQuery {
  readonly clusterId: AgentClusterId;
}

export interface CreateClusterCommand extends ClusterQuery {
  readonly name: string;
  readonly slug?: string | null;
  readonly description?: string | null;
  readonly primaryAgentId?: string | null;
}

export interface UpdateClusterCommand extends DescribeClusterQuery, ClusterPatch {}

export interface ClusterMembershipCommand extends DescribeClusterQuery {
  readonly agentId: AgentId;
}

/** A cluster with the membership only its bindings can supply. */
export interface ClusterWithMembers {
  readonly cluster: AgentCluster;
  readonly members: readonly AgentId[];
}

export async function listClusters(
  dependencies: AgentsDependencies,
  query: ClusterQuery,
): Promise<Result<readonly AgentCluster[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const listed = await dependencies.repository.listClusters(granted.value.scope);
  if (!listed.ok) return err(listed.error);
  return ok([...listed.value].sort(byClusterOrder));
}

export async function describeCluster(
  dependencies: AgentsDependencies,
  query: DescribeClusterQuery,
): Promise<Result<ClusterWithMembers>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  return withMembers(dependencies, granted.value.scope, query.clusterId);
}

export async function createCluster(
  dependencies: AgentsDependencies,
  command: CreateClusterCommand,
): Promise<Result<ClusterWithMembers>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const admitted = admitCluster(command);
  if (!admitted.ok) return err(admitted.error);
  const baseSlug = admitSlug(admitted.value.name, command.slug);
  if (!baseSlug.ok) return err(baseSlug.error);

  const existing = await dependencies.repository.listClusters(scope);
  if (!existing.ok) return err(existing.error);

  const now = dependencies.clock.now();
  const taken = existing.value.map((cluster) => cluster.slug as string);
  const slug = resolveSlug(baseSlug.value, taken, now);
  // Asked of the DOMAIN predicate rather than re-implemented here. The rule —
  // a cluster slug is unique within an ENVIRONMENT — has one statement, in
  // `domain/cluster.ts`, and this is its caller. The inline `taken.includes`
  // that stood here was a second implementation of it, and it also dropped the
  // environment comparison the rule is about: correct only for as long as
  // `listClusters` is scoped, which is an adapter's promise rather than this
  // context's guarantee.
  if (clusterSlugIsTaken(existing.value, scope.environmentId, slug)) {
    return err(clusterAlreadyExists(scope.environmentId, slug));
  }

  // A primary named at creation must already be bound HERE. Accepting an
  // unbound id would write a cluster whose primary is an agent this environment
  // cannot see, which no later read can repair.
  if (admitted.value.primaryAgentId !== null) {
    const bound = await requireBound(dependencies, scope, admitted.value.primaryAgentId);
    if (!bound.ok) return err(bound.error);
  }

  const cluster: AgentCluster = {
    clusterId: asAgentsIdentifier<AgentClusterId>(dependencies.ids.uuid()),
    environmentId: scope.environmentId,
    name: admitted.value.name,
    slug,
    description: admitted.value.description,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };
  const seeded =
    admitted.value.primaryAgentId === null
      ? cluster
      : electOnJoin(cluster, admitted.value.primaryAgentId, now);

  const written = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.insertCluster(seeded, transaction),
  );
  if (!written.ok) return err(written.error);
  return ok({ cluster: written.value, members: [] });
}

export async function updateCluster(
  dependencies: AgentsDependencies,
  command: UpdateClusterCommand,
): Promise<Result<ClusterWithMembers>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const existing = await dependencies.repository.findCluster(scope, command.clusterId);
  if (!existing.ok) return err(existing.error);
  if (existing.value === null) return err(clusterNotFound(command.clusterId));

  if (command.primaryAgentId !== undefined && command.primaryAgentId !== null && command.primaryAgentId !== "") {
    const bound = await requireBound(
      dependencies,
      scope,
      asAgentsIdentifier<AgentId>(command.primaryAgentId),
    );
    if (!bound.ok) return err(bound.error);
  }

  const patched = applyClusterPatch(existing.value, command, dependencies.clock.now());
  const written = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.updateCluster(patched, transaction),
  );
  if (!written.ok) return err(written.error);
  return withMembers(dependencies, scope, command.clusterId);
}

export async function removeCluster(
  dependencies: AgentsDependencies,
  query: DescribeClusterQuery,
): Promise<Result<boolean>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const existing = await dependencies.repository.findCluster(scope, query.clusterId);
  if (!existing.ok) return err(existing.error);
  if (existing.value === null) return ok(false);

  return dependencies.unitOfWork.run(async (transaction) => {
    const detached = await dependencies.repository.detachClusterMembers(
      scope,
      query.clusterId,
      transaction,
    );
    if (!detached.ok) return err(detached.error);
    return dependencies.repository.deleteCluster(scope, query.clusterId, transaction);
  });
}

export async function addAgentToCluster(
  dependencies: AgentsDependencies,
  command: ClusterMembershipCommand,
): Promise<Result<ClusterWithMembers>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const found = await dependencies.repository.findCluster(scope, command.clusterId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(clusterNotFound(command.clusterId));
  const cluster = found.value;
  const bound = await requireBound(dependencies, scope, command.agentId);
  if (!bound.ok) return err(bound.error);
  const binding = bound.value.binding;

  const now = dependencies.clock.now();
  const joined = await dependencies.unitOfWork.run(async (transaction) => {
    const moved = await dependencies.repository.updateBinding(
      assignCluster(binding, command.clusterId, now),
      transaction,
    );
    if (!moved.ok) return err(moved.error);
    const elected = electOnJoin(cluster, command.agentId, now);
    if (elected === cluster) return ok(cluster);
    return dependencies.repository.updateCluster(elected, transaction);
  });
  if (!joined.ok) return err(joined.error);
  return withMembers(dependencies, scope, command.clusterId);
}

export async function removeAgentFromCluster(
  dependencies: AgentsDependencies,
  command: ClusterMembershipCommand,
): Promise<Result<ClusterWithMembers>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const found = await dependencies.repository.findCluster(scope, command.clusterId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(clusterNotFound(command.clusterId));
  const cluster = found.value;
  const members = await dependencies.repository.listClusterMembers(scope, command.clusterId);
  if (!members.ok) return err(members.error);
  const bound = await requireBound(dependencies, scope, command.agentId);
  if (!bound.ok) return err(bound.error);
  const binding = bound.value.binding;

  const now = dependencies.clock.now();
  const remaining = members.value.filter((member) => member !== command.agentId);
  const left = await dependencies.unitOfWork.run(async (transaction) => {
    const moved = await dependencies.repository.updateBinding(
      assignCluster(binding, null, now),
      transaction,
    );
    if (!moved.ok) return err(moved.error);
    const elected = electOnLeave(cluster, command.agentId, remaining, now);
    if (elected === cluster) return ok(cluster);
    return dependencies.repository.updateCluster(elected, transaction);
  });
  if (!left.ok) return err(left.error);
  return withMembers(dependencies, scope, command.clusterId);
}

async function withMembers(
  dependencies: AgentsDependencies,
  scope: EnvironmentScope,
  clusterId: AgentClusterId,
): Promise<Result<ClusterWithMembers>> {
  const cluster = await dependencies.repository.findCluster(scope, clusterId);
  if (!cluster.ok) return err(cluster.error);
  if (cluster.value === null) return err(clusterNotFound(clusterId));
  const members = await dependencies.repository.listClusterMembers(scope, clusterId);
  if (!members.ok) return err(members.error);
  return ok({ cluster: cluster.value, members: members.value });
}
