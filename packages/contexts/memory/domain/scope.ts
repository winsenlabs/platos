// Where a memory lives, and which agents may see it.
//
// Every row this context owns is keyed by FOUR things, and all four have to
// agree before a row is readable: the environment, the end user, the agent, and
// — when the agent belongs to one — the agent cluster. The environment comes
// from the kernel's `EnvironmentScope`; the other three are here.
//
// THE CLUSTER IS THE WHOLE OF CROSS-AGENT SHARING. There is no share table, no
// visibility grant between agents and no "public" memory. Two agents see each
// other's rows exactly when their bindings name the same non-null cluster, and
// that single predicate — `canShareAgentScope` — is what every read and every
// write in this context reduces to. It is transcribed from the source, where the
// same three-line rule is repeated at six call sites.
//
// THE RESOLUTION RULES ARE PURE FUNCTIONS OVER A SET OF BINDINGS. The source
// interleaves them with database round trips, which is why "which agents may
// this caller read?" is currently only answerable by running a query. Here the
// repository fetches the environment's bindings and these functions decide, so
// every branch — including the two that refuse — is exercisable in memory.

import { err, ok, resolvePath, type EnvironmentScope, type Result } from "@platos/kernel";

import { agentAmbiguous, agentScopeDenied } from "./errors.js";
import type { AgentId, ClusterId, EndUserId } from "./identifiers.js";

/**
 * One agent's placement in an environment — the `AgentBinding` row, reduced to
 * the two columns this context reads. `clusterId` is null for an agent that
 * belongs to no cluster, and a null NEVER shares scope with another null.
 */
export interface AgentBinding {
  readonly agentId: AgentId;
  readonly clusterId: ClusterId | null;
}

/** The subject and the environment: what every row in this context is keyed by. */
export interface MemorySubject {
  readonly environment: EnvironmentScope;
  readonly endUserId: EndUserId;
}

export function memorySubject(environment: EnvironmentScope, endUserId: EndUserId): MemorySubject {
  return { environment, endUserId };
}

/**
 * The canonical string form of a subject, built on the kernel's `resolvePath()`
 * so a cache namespace, a log field and an extraction watermark all agree by
 * construction rather than by convention.
 */
export function subjectPath(subject: MemorySubject): string {
  return `${resolvePath(subject.environment)}/user/${subject.endUserId}`;
}

export function sameSubject(left: MemorySubject, right: MemorySubject): boolean {
  return subjectPath(left) === subjectPath(right);
}

/**
 * May `left` see `right`'s rows?
 *
 * True when they are the same agent, or when both name the SAME non-null
 * cluster. Two unclustered agents are not one scope, however alike they look —
 * that is why the null check is on the left value and not just an equality.
 */
export function canShareAgentScope(left: AgentBinding, right: AgentBinding): boolean {
  if (left.agentId === right.agentId) return true;
  return left.clusterId !== null && left.clusterId === right.clusterId;
}

/** Who a memory belongs to. Denormalised onto the row exactly as the schema has it. */
export interface MemoryOwnership {
  readonly agentId: AgentId;
  readonly clusterId: ClusterId | null;
}

export function ownershipOf(binding: AgentBinding): MemoryOwnership {
  return { agentId: binding.agentId, clusterId: binding.clusterId };
}

/**
 * The ownership key an entity upsert serialises on.
 *
 * A clustered node is one node for the whole cluster; an unclustered node is one
 * node per agent. Deriving the key from the binding rather than branching at
 * every call site is what keeps the two cases from drifting apart.
 */
export function ownershipKey(ownership: MemoryOwnership): string {
  return ownership.clusterId === null ? `agent:${ownership.agentId}` : `cluster:${ownership.clusterId}`;
}

/** What a caller asked to write as, and what is acting on its behalf. */
export interface WriteBindingRequest {
  /** The agent whose credentials are running. Null for an operator write. */
  readonly actingAgentId: AgentId | null;
  /** The agent the caller named, if any. */
  readonly requestedAgentId: AgentId | null;
  /** The binding of the thread the memory came from, when there is one. */
  readonly sourceThreadBinding: AgentBinding | null;
}

/**
 * Decide which agent a write is attributed to.
 *
 * The precedence is the source's, and each step exists for a different reason:
 *
 *   1. AN ACTING AGENT OWNS ITS OWN WRITES. When one is present it wins, and a
 *      caller naming a DIFFERENT agent is honoured only if the two share a
 *      cluster. Without that check an agent could write into a peer's memory.
 *   2. AN OPERATOR MAY NAME ONE. With no acting agent, the named agent is used
 *      if it is bound here.
 *   3. A SOURCE THREAD SPEAKS FOR ITSELF. A memory extracted from a thread is
 *      attributed to the thread's agent, which is how extraction attributes rows
 *      without the extractor having to state an agent at all.
 *   4. A SINGLE-AGENT ENVIRONMENT IS UNAMBIGUOUS. Exactly one binding means
 *      there is nothing to choose.
 *
 * Anything else REFUSES. Picking the first of several bindings is the silent
 * mis-attribution this ordering exists to prevent.
 */
export function resolveWriteBinding(
  bindings: readonly AgentBinding[],
  request: WriteBindingRequest,
): Result<AgentBinding> {
  const find = (agentId: AgentId): AgentBinding | undefined =>
    bindings.find((binding) => binding.agentId === agentId);

  if (request.actingAgentId !== null) {
    const acting = find(request.actingAgentId);
    if (acting === undefined) return err(agentScopeDenied("acting agent is not bound here", request.actingAgentId));
    if (request.requestedAgentId === null || request.requestedAgentId === acting.agentId) return ok(acting);
    const requested = find(request.requestedAgentId);
    if (requested === undefined) {
      return err(agentScopeDenied("requested agent is not bound here", request.requestedAgentId));
    }
    if (!canShareAgentScope(acting, requested)) {
      return err(agentScopeDenied("write agent is outside the acting agent cluster", requested.agentId));
    }
    return ok(requested);
  }

  if (request.requestedAgentId !== null) {
    const requested = find(request.requestedAgentId);
    if (requested === undefined) {
      return err(agentScopeDenied("requested agent is not bound here", request.requestedAgentId));
    }
    return ok(requested);
  }

  if (request.sourceThreadBinding !== null) return ok(request.sourceThreadBinding);

  const only = bindings[0];
  if (bindings.length !== 1 || only === undefined) return err(agentAmbiguous(bindings.length));
  return ok(only);
}

/** What a caller asked to read, and what is acting on its behalf. */
export interface ReadBindingRequest {
  readonly actingAgentId: AgentId | null;
  readonly requestedAgentIds: readonly AgentId[];
}

/**
 * Decide which agents a read may span.
 *
 * With no target named at all, the environment itself has to be unambiguous:
 * one binding, or several that all share ONE non-null cluster. A mixed
 * environment refuses rather than silently reading one agent's slice.
 *
 * With targets named, every one must be bound here, and then either the acting
 * agent must share scope with each of them, or — for an operator, with no acting
 * agent — they must all sit in one cluster. The returned order is the CALLER'S,
 * not the store's, because a caller that named three agents expects its own
 * ordering back.
 */
export function resolveReadBindings(
  bindings: readonly AgentBinding[],
  request: ReadBindingRequest,
): Result<readonly AgentBinding[]> {
  const targets = dedupe(
    request.requestedAgentIds.length > 0
      ? request.requestedAgentIds
      : request.actingAgentId !== null
        ? [request.actingAgentId]
        : [],
  );
  if (targets.length === 0) return wholeEnvironment(bindings);

  const resolved: AgentBinding[] = [];
  for (const agentId of targets) {
    const binding = bindings.find((candidate) => candidate.agentId === agentId);
    if (binding === undefined) return err(agentScopeDenied("agent scope not found or access denied", agentId));
    resolved.push(binding);
  }

  if (request.actingAgentId !== null) {
    const acting = bindings.find((candidate) => candidate.agentId === request.actingAgentId);
    if (acting === undefined) {
      return err(agentScopeDenied("acting agent is not bound here", request.actingAgentId));
    }
    const outside = resolved.find((target) => !canShareAgentScope(acting, target));
    if (outside !== undefined) {
      return err(agentScopeDenied("requested agent is outside the acting agent cluster", outside.agentId));
    }
    return ok(resolved);
  }

  return resolved.length > 1 ? requireOneCluster(resolved) : ok(resolved);
}

/** Every agent in the acting agent's cluster, or the agent alone when it has none. */
export function clusterPeers(
  bindings: readonly AgentBinding[],
  acting: AgentBinding,
): readonly AgentBinding[] {
  if (acting.clusterId === null) return [acting];
  return bindings.filter((binding) => binding.clusterId === acting.clusterId);
}

function wholeEnvironment(bindings: readonly AgentBinding[]): Result<readonly AgentBinding[]> {
  if (bindings.length === 1) return ok(bindings);
  if (bindings.length === 0) return err(agentAmbiguous(0));
  return requireOneCluster(bindings);
}

function requireOneCluster(bindings: readonly AgentBinding[]): Result<readonly AgentBinding[]> {
  const first = bindings[0];
  if (first === undefined || first.clusterId === null) {
    return err(agentScopeDenied("cross-agent memory access requires one shared agent cluster"));
  }
  const stray = bindings.find((binding) => binding.clusterId !== first.clusterId);
  if (stray !== undefined) {
    return err(agentScopeDenied("cross-agent memory access requires one shared agent cluster", stray.agentId));
  }
  return ok(bindings);
}

function dedupe(agentIds: readonly AgentId[]): readonly AgentId[] {
  return [...new Set(agentIds.filter((agentId) => agentId.length > 0))];
}
