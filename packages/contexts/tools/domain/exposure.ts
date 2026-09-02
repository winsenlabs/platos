// `EnvironmentEntityTool` — the dispatch matrix, and the only mutable half of
// what a tool IS in this context.
//
// One row says: in THIS environment, THIS entity offers THIS tool version, at
// THIS callback, switched on or off. `@@unique([environmentId, entityId,
// toolId])`. Every question the rest of the context asks — can this agent see
// it, can it be called at all, which of three entities gets the call — is
// answered from a set of these.
//
// THREE INDEPENDENT BOOLEANS, AND COLLAPSING ANY TWO IS A BUG.
//
//   enabled       an operator switched this exposure off. Persisted.
//   dispatchable  the entity has somewhere to send the call. DERIVED, and
//                 recomputed from transport liveness rather than stored.
//   visible       this agent's active version's tool policy permits it.
//                 Derived per-agent; see `domain/agent-policy.ts`.
//
// A surface that showed one flag could not tell an operator whether to switch
// the tool on, fix the backend, or edit the agent's policy — and the source
// keeps all three for exactly that reason.
//
// WHY `dispatchable` IS DERIVED AND NOT A COLUMN. A wire entity is dispatchable
// while a socket is open; an MCP entity is dispatchable while an
// `EntityMcpClient` row exists. Neither fact belongs in a table that outlives
// the process holding the socket, and a stored flag would strand every tool of
// a backend that crashed. `dispatchabilityOf` states the rule once so the
// registry rebuild and the live liveness callback cannot disagree.

import type { EnvironmentId, EntityId } from "@platos/kernel";

import type {
  AgentId,
  ExposureId,
  ExternalEntityId,
  ToolId,
  ToolName,
} from "./identifiers.js";

/**
 * `Entity.connectionKind` — how a call reaches the backend.
 *
 * `wire` is the inbound WebSocket a backend opens to Platos; `mcp` is the
 * outbound client Platos opens to the backend. They are not variants of one
 * transport: the direction of the connection is what decides whether liveness
 * is something Platos observes or something it attempts.
 */
export const CONNECTION_KINDS = ["wire", "mcp"] as const;

export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/** One (environment, entity, tool) row, resolved for use. */
export interface ToolExposure {
  readonly exposureId: ExposureId;
  readonly environmentId: EnvironmentId;
  /** `Entity.id`. The row's foreign key. */
  readonly entityId: EntityId;
  /** `Entity.externalId`. What a caller and a `ToolHealth` row name it by. */
  readonly externalEntityId: ExternalEntityId;
  readonly toolId: ToolId;
  readonly toolName: ToolName;
  readonly description: string;
  readonly paramSchema: Readonly<Record<string, unknown>>;
  readonly category: string;
  /** `""` when the entity has no persistent callback, never null. */
  readonly callbackUrl: string;
  readonly connectionKind: ConnectionKind;
  readonly enabled: boolean;
  readonly dispatchable: boolean;
  /** Agents whose active version's policy permits this tool. Sorted. */
  readonly allowedAgentIds: readonly AgentId[];
  /** `EntityMcpConfig.injectMcpContext`, carried so dispatch need not re-read it. */
  readonly injectMcpContext: boolean;
}

/**
 * Is this entity's transport good for a call right now?
 *
 * An `mcp` entity needs a client row — there is nothing to open a session
 * against without one. A `wire` entity needs a callback URL that is actually a
 * URL, which is what makes an entity whose socket has dropped still
 * dispatchable: the callback outlives the connection, and the source's
 * `setEntityDispatchable` keeps that exposure live for exactly that reason.
 */
export function dispatchabilityOf(input: {
  readonly connectionKind: ConnectionKind;
  readonly callbackUrl: string | null;
  readonly hasMcpClient: boolean;
  readonly transportLive?: boolean;
}): boolean {
  if (input.connectionKind === "mcp") return input.hasMcpClient;
  if (input.transportLive === true) return true;
  return hasPersistentCallback(input.callbackUrl ?? "");
}

/**
 * A callback is persistent when it is an absolute http(s) URL.
 *
 * Transcribed as a scheme test, not a URL parse. A relative path, an empty
 * string and a `ws://` upgrade all fail it, which is the point: those are the
 * three shapes a backend that can only be reached over its live socket sends.
 */
export function hasPersistentCallback(callbackUrl: string): boolean {
  return /^https?:\/\//iu.test(callbackUrl);
}

/**
 * The total order every listing, index build and page shares.
 *
 * Tool name, then the entity that offers it, then the tool version. The final
 * `toolId` comparison is what makes it TOTAL: two entities can expose the same
 * name, one entity can expose two versions of it, and a paged listing whose
 * order is not total silently drops and repeats rows across pages.
 */
export function byExposureOrder(left: ToolExposure, right: ToolExposure): number {
  if (left.toolName !== right.toolName) return left.toolName < right.toolName ? -1 : 1;
  if (left.externalEntityId !== right.externalEntityId) {
    return left.externalEntityId < right.externalEntityId ? -1 : 1;
  }
  if (left.toolId === right.toolId) return 0;
  return left.toolId < right.toolId ? -1 : 1;
}

/**
 * May this agent see this exposure?
 *
 * NO AGENT MEANS NO FILTER. Transcribed: an operator listing an environment's
 * matrix, and an MCP client calling with a scope token rather than as an agent,
 * both pass no agent id and both must see everything the scope exposes. The
 * per-agent narrowing is `agents`' policy, not a tenancy boundary, and applying
 * it to a caller that is not an agent would hide rows from the operator who
 * configured them.
 */
export function isVisibleToAgent(exposure: ToolExposure, agentId: AgentId | null): boolean {
  return agentId === null || exposure.allowedAgentIds.includes(agentId);
}

/** Enabled, dispatchable, and visible — the exposures a turn may actually call. */
export function isCallable(exposure: ToolExposure, agentId: AgentId | null): boolean {
  return exposure.enabled && exposure.dispatchable && isVisibleToAgent(exposure, agentId);
}

export interface ExposureFilter {
  /** Only exposures of these entities. Empty means no entity filter at all. */
  readonly externalEntityIds?: readonly ExternalEntityId[];
  readonly agentId?: AgentId | null;
  /** Default true — drop anything not enabled AND dispatchable. */
  readonly callableOnly?: boolean;
}

/**
 * Narrow a matrix, in the one order everything else uses.
 *
 * An EMPTY entity list is not a filter that matches nothing; it is the absence
 * of a filter. That asymmetry is transcribed from the source's `req.entityIds
 * && req.entityIds.length > 0` guard and it matters: a caller that resolved an
 * empty entity set from an absent session key would otherwise silently lose
 * every tool it has, which reads to a model as "this scope has no tools".
 */
export function selectExposures(
  exposures: readonly ToolExposure[],
  filter: ExposureFilter = {},
): readonly ToolExposure[] {
  const agentId = filter.agentId ?? null;
  const callableOnly = filter.callableOnly ?? true;
  const entityIds = filter.externalEntityIds ?? [];
  const wanted = entityIds.length === 0 ? null : new Set<string>(entityIds);

  return exposures
    .filter((exposure) => {
      if (wanted !== null && !wanted.has(exposure.externalEntityId)) return false;
      if (!isVisibleToAgent(exposure, agentId)) return false;
      return !callableOnly || (exposure.enabled && exposure.dispatchable);
    })
    .sort(byExposureOrder);
}

/** The distinct entities contributing at least one exposure, in matrix order. */
export function contributingEntities(
  exposures: readonly ToolExposure[],
): readonly { readonly entityId: EntityId; readonly externalEntityId: ExternalEntityId }[] {
  const seen = new Map<EntityId, { entityId: EntityId; externalEntityId: ExternalEntityId }>();
  for (const exposure of [...exposures].sort(byExposureOrder)) {
    if (!seen.has(exposure.entityId)) {
      seen.set(exposure.entityId, {
        entityId: exposure.entityId,
        externalEntityId: exposure.externalEntityId,
      });
    }
  }
  return [...seen.values()];
}

export function withEnabled(exposure: ToolExposure, enabled: boolean): ToolExposure {
  return { ...exposure, enabled };
}

export function withDispatchable(exposure: ToolExposure, dispatchable: boolean): ToolExposure {
  return { ...exposure, dispatchable };
}

export function withAllowedAgents(
  exposure: ToolExposure,
  allowedAgentIds: readonly AgentId[],
): ToolExposure {
  return { ...exposure, allowedAgentIds: [...allowedAgentIds].sort() };
}
