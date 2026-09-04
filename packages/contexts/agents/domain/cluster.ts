// `AgentCluster` — a named group of agents inside one environment.
//
// A cluster owns no membership rows. Membership IS `AgentBinding.clusterId`,
// which is why a cluster is environment-scoped even though an agent is not: an
// agent belongs to a cluster in one environment and to nothing in another, and
// there is no place for that fact to live except the binding.
//
// THE PRIMARY AGENT LIVES IN `metadata`, AND THAT IS THE SHARP EDGE. There is no
// column for it — it is a key inside a free-form JSON blob — so three rules that
// would be foreign keys anywhere else are hand-maintained, and all three are
// modelled here rather than spread across the call sites that currently hold
// them:
//
//   1. Adding the FIRST agent to a cluster with no primary elects it.
//   2. Removing the primary re-elects one of the remaining members.
//   3. Removing the last member deletes the key rather than leaving it pointing
//      at an agent that is no longer in the cluster.
//
// Rule 3 is the one the source gets right by accident and the one a rewrite
// would most easily lose: `delete metadata.primaryAgentId` when no successor
// exists. A stale primary pointing outside its own cluster is not a display bug
// — it is a routing decision made against an agent nobody put there.

import { err, ok, type EnvironmentId, type Result } from "@platos/kernel";

import { agentMetadataInvalid } from "./errors.js";
import type { AgentClusterId, AgentId, Slug } from "./identifiers.js";
import type { JsonObject } from "./snapshot.js";

/** The `metadata` key that names a cluster's primary agent. */
export const PRIMARY_AGENT_KEY = "primaryAgentId";

/** Ceiling on an operator-supplied cluster name. */
export const MAX_CLUSTER_NAME_LENGTH = 200;

export interface AgentCluster {
  readonly clusterId: AgentClusterId;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly slug: Slug;
  readonly description: string | null;
  readonly metadata: JsonObject | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ClusterIntake {
  readonly name: string;
  readonly description?: string | null;
  readonly primaryAgentId?: string | null;
}

export interface AdmittedCluster {
  readonly name: string;
  readonly description: string | null;
  readonly primaryAgentId: AgentId | null;
}

export function admitCluster(intake: ClusterIntake): Result<AdmittedCluster> {
  const name = intake.name.trim();
  if (name === "") {
    return err(
      agentMetadataInvalid("name is required", [
        { field: "name", code: "required", message: "name is required" },
      ]),
    );
  }
  if (name.length > MAX_CLUSTER_NAME_LENGTH) {
    return err(
      agentMetadataInvalid(`name must be at most ${MAX_CLUSTER_NAME_LENGTH} characters`, [
        { field: "name", code: "too_long", message: "name is too long" },
      ]),
    );
  }
  const description = intake.description?.trim();
  const primary = intake.primaryAgentId?.trim();
  return ok({
    name,
    description: description === undefined || description === "" ? null : description,
    primaryAgentId: primary === undefined || primary === "" ? null : (primary as AgentId),
  });
}

/** The primary agent a cluster's metadata names, or null. */
export function primaryAgentOf(cluster: AgentCluster): AgentId | null {
  const value = cluster.metadata?.[PRIMARY_AGENT_KEY];
  return typeof value === "string" && value !== "" ? (value as AgentId) : null;
}

function withPrimary(metadata: JsonObject | null, agentId: AgentId | null): JsonObject | null {
  const entries: Record<string, unknown> = { ...(metadata ?? {}) };
  if (agentId === null) delete entries[PRIMARY_AGENT_KEY];
  else entries[PRIMARY_AGENT_KEY] = agentId;
  return Object.keys(entries).length === 0 ? null : (entries as JsonObject);
}

/** Set or clear the primary, preserving every other metadata key. */
export function setPrimaryAgent(
  cluster: AgentCluster,
  agentId: AgentId | null,
  now: Date,
): AgentCluster {
  return { ...cluster, metadata: withPrimary(cluster.metadata, agentId), updatedAt: now };
}

/**
 * Rule 1 — the metadata a cluster carries after an agent joins it.
 *
 * An existing primary is left alone. Re-electing on every join would move the
 * primary to whoever was added last, which is neither what an operator asked for
 * nor visible anywhere they would notice.
 */
export function electOnJoin(cluster: AgentCluster, joining: AgentId, now: Date): AgentCluster {
  return primaryAgentOf(cluster) === null ? setPrimaryAgent(cluster, joining, now) : cluster;
}

/**
 * Rules 2 and 3 — the metadata a cluster carries after an agent leaves it.
 *
 * `remainingMembers` is the membership AFTER the removal, in the caller's own
 * order; the first is elected. The source takes the first binding whose agent is
 * not the departing one, so the choice is the store's ordering rather than a
 * rule — stated here so a caller knows the successor is arbitrary and not, say,
 * the oldest member.
 */
export function electOnLeave(
  cluster: AgentCluster,
  leaving: AgentId,
  remainingMembers: readonly AgentId[],
  now: Date,
): AgentCluster {
  if (primaryAgentOf(cluster) !== leaving) return cluster;
  const successor = remainingMembers.find((member) => member !== leaving) ?? null;
  return setPrimaryAgent(cluster, successor, now);
}

/** What changed on a cluster row, as an operator supplied it. */
export interface ClusterPatch {
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string | null;
  /** Three states: absent leaves it, `null` clears it, a value sets it. */
  readonly primaryAgentId?: string | null;
}

export function applyClusterPatch(cluster: AgentCluster, patch: ClusterPatch, now: Date): AgentCluster {
  const renamed: AgentCluster = {
    ...cluster,
    name: patch.name ?? cluster.name,
    slug: (patch.slug as Slug | undefined) ?? cluster.slug,
    description: patch.description === undefined ? cluster.description : patch.description,
    updatedAt: now,
  };
  if (patch.primaryAgentId === undefined) return renamed;
  const primary = patch.primaryAgentId === null || patch.primaryAgentId === ""
    ? null
    : (patch.primaryAgentId as AgentId);
  return setPrimaryAgent(renamed, primary, now);
}

/**
 * The listing order, transcribed exactly: newest first, then by id descending.
 * The id tie-break is what makes the order total across pages.
 */
export function byClusterOrder(left: AgentCluster, right: AgentCluster): number {
  const byAge = right.createdAt.getTime() - left.createdAt.getTime();
  if (byAge !== 0) return byAge;
  if (left.clusterId === right.clusterId) return 0;
  return left.clusterId > right.clusterId ? -1 : 1;
}

/** True when a cluster already carries the slug another cluster wants. */
export function clusterSlugIsTaken(
  clusters: readonly AgentCluster[],
  environmentId: EnvironmentId,
  slug: Slug,
  excluding: AgentClusterId | null = null,
): boolean {
  return clusters.some(
    (cluster) =>
      cluster.environmentId === environmentId && cluster.slug === slug && cluster.clusterId !== excluding,
  );
}
