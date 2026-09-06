// `AgentCluster` — the environment-scoped grouping whose membership IS the
// binding.
//
// EVERY READ AND EVERY WRITE CARRIES THE ENVIRONMENT, and on the writes it is
// carried for a reason the schema states twice. `AgentCluster_owner_immutable`
// refuses an UPDATE that changes `environmentId`, so writing the value the
// caller holds turns "this record belongs to another environment" into a refusal
// rather than a silent move; and `enforce_domain_ancestry` refuses a binding
// whose cluster is in a different environment, so a cluster that moved would
// take every binding that names it with it.
//
// REMOVING A CLUSTER AND DETACHING ITS MEMBERS ARE TWO CALLS, because they are
// two rows with two owner checks. `detachClusterMembers` writes `AgentBinding`;
// `deleteCluster` writes `AgentCluster`. Folding the first into the second would
// hide a multi-row mutation behind a name that reads like a single delete — and
// would also hide the ordering, which is not optional: the cluster's foreign key
// is `onDelete: SetNull`, so a delete that ran first would clear the column
// without the caller ever learning how many bindings it touched.

import type {
  AgentCluster,
  AgentClusterId,
  AgentId,
  EnvironmentScope,
  Result,
  TransactionScope,
} from "@platos/context-agents/application/ports/index.js";
import { clusterAlreadyExists, err, ok } from "@platos/context-agents/application/ports/index.js";

import {
  CHECK_VIOLATION,
  checkRefusal,
  CLUSTER_MISSING,
  namesConstraint,
  refusable,
  refused,
  sqlstateOf,
  UNIQUE_VIOLATION,
} from "./agents-guards.js";
import { nullableJson } from "./client.js";
import type { AgentClusterRow } from "./agents-rows.js";
import { CLUSTER_COLUMNS, toCluster } from "./agents-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** `byClusterOrder`: newest first, then by id descending. */
const CLUSTER_ORDER = [{ createdAt: "desc" }, { id: "desc" }] as const;

function clusterWriteRefusal(cluster: AgentCluster) {
  return (error: unknown) => {
    if (sqlstateOf(error) === UNIQUE_VIOLATION && namesConstraint(error, "environmentId,slug")) {
      return clusterAlreadyExists(cluster.environmentId, cluster.slug);
    }
    if (sqlstateOf(error) === CHECK_VIOLATION) {
      const reason = checkRefusal(error);
      return reason === null ? null : refused(reason);
    }
    return null;
  };
}

export function createAgentClusters(transactions: TenancyTransactions) {
  const data = (cluster: AgentCluster) => ({
    environmentId: cluster.environmentId,
    name: cluster.name,
    slug: cluster.slug,
    description: cluster.description,
    metadata: nullableJson(cluster.metadata) as never,
    updatedAt: cluster.updatedAt,
  });

  return {
    async findCluster(
      scope: EnvironmentScope,
      clusterId: AgentClusterId,
    ): Promise<Result<AgentCluster | null>> {
      const row = (await transactions.reader().agentCluster.findFirst({
        where: { id: clusterId, environmentId: scope.environmentId },
        select: CLUSTER_COLUMNS,
      })) as AgentClusterRow | null;
      return ok(row === null ? null : toCluster(row));
    },

    async listClusters(scope: EnvironmentScope): Promise<Result<readonly AgentCluster[]>> {
      const rows = (await transactions.reader().agentCluster.findMany({
        where: { environmentId: scope.environmentId },
        orderBy: [...CLUSTER_ORDER],
        select: CLUSTER_COLUMNS,
      })) as AgentClusterRow[];
      return ok(rows.map(toCluster));
    },

    async listClusterMembers(
      scope: EnvironmentScope,
      clusterId: AgentClusterId,
    ): Promise<Result<readonly AgentId[]>> {
      // Read off the BINDING, which is what membership is, and scoped by the
      // environment as well as the cluster: a cluster id is unique, but reading
      // it without the environment would answer for a scope the caller was not
      // granted the moment two environments ever shared one.
      const rows = await transactions.reader().agentBinding.findMany({
        where: { clusterId, environmentId: scope.environmentId, agent: { projectId: scope.projectId } },
        select: { agentId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return ok(rows.map((row) => row.agentId as AgentId));
    },

    async insertCluster(
      cluster: AgentCluster,
      transaction: TransactionScope,
    ): Promise<Result<AgentCluster>> {
      const client = transactions.writer(transaction);
      const written = await refusable(
        client,
        () =>
          client.agentCluster.create({
            data: { id: cluster.clusterId, createdAt: cluster.createdAt, ...data(cluster) },
          }),
        clusterWriteRefusal(cluster),
      );
      return written.ok ? ok(toCluster(written.value as AgentClusterRow)) : err(written.error);
    },

    async updateCluster(
      cluster: AgentCluster,
      transaction: TransactionScope,
    ): Promise<Result<AgentCluster>> {
      const client = transactions.writer(transaction);
      const written = await refusable(
        client,
        () =>
          client.agentCluster.updateManyAndReturn({
            where: { id: cluster.clusterId },
            data: data(cluster),
          }),
        clusterWriteRefusal(cluster),
      );
      if (!written.ok) return err(written.error);
      const row = (written.value as AgentClusterRow[])[0];
      return row === undefined ? err(refused(CLUSTER_MISSING)) : ok(toCluster(row));
    },

    async deleteCluster(
      scope: EnvironmentScope,
      clusterId: AgentClusterId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      const removed = await transactions.writer(transaction).agentCluster.deleteMany({
        where: { id: clusterId, environmentId: scope.environmentId },
      });
      return ok(removed.count > 0);
    },

    async detachClusterMembers(
      scope: EnvironmentScope,
      clusterId: AgentClusterId,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      const detached = await transactions.writer(transaction).agentBinding.updateMany({
        where: { clusterId, environmentId: scope.environmentId },
        data: { clusterId: null },
      });
      return ok(detached.count);
    },
  };
}
