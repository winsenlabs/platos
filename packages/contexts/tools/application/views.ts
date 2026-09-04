// Projections from this context's aggregates to the shapes the contract
// publishes.
//
// They live in `application/` rather than in `contracts/` so the contract stays
// what its own note says it is — a lookup table from a method to the use case
// that implements it — and cannot quietly grow behaviour.
//
// EVERY BRAND IS DROPPED AT THIS BOUNDARY. A `ToolId` leaves as a `string`,
// because a brand is a compile-time property of THIS package and a consumer
// re-branding one would be asserting a provenance it does not have. What a
// consumer gets back is an opaque string it may hand to another method of this
// same contract, which is all a handle needs to be.
//
// THREE THINGS ARE WITHHELD AND EACH FOR A DIFFERENT REASON.
//
//   `callbackUrl` NEVER LEAVES. It is the address of a customer's backend and
//   often carries a path segment that is effectively a shared secret. A
//   consumer that needs to know whether a tool can be called reads
//   `dispatchable`, which is the question they were actually asking.
//
//   `credentialId` and `credentialName` never leave an `EntityMcpClient` view.
//   An id is a handle into `secrets`' store, and handing one out invites a
//   caller to try to use it.
//
//   RESOLVED HEADERS have no view at all. There is no method that returns one
//   and no field that could hold one; the substituted set exists only between
//   `resolve-transport.ts` and the adapter that spends it.

import type {
  AuditEntry,
  EntityMcpConfig,
  EntityToolPolicy,
  PermissionDecision,
  ToolExposure,
  ToolHealth,
} from "../domain/index.js";

export interface ToolView {
  readonly exposureId: string;
  readonly toolId: string;
  readonly toolName: string;
  readonly description: string;
  readonly paramSchema: Readonly<Record<string, unknown>>;
  readonly category: string;
  readonly entityId: string;
  readonly externalEntityId: string;
  readonly connectionKind: string;
  readonly enabled: boolean;
  readonly dispatchable: boolean;
  readonly allowedAgentIds: readonly string[];
}

export function toToolView(exposure: ToolExposure): ToolView {
  return {
    exposureId: exposure.exposureId,
    toolId: exposure.toolId,
    toolName: exposure.toolName,
    description: exposure.description,
    paramSchema: exposure.paramSchema,
    category: exposure.category,
    entityId: exposure.entityId,
    externalEntityId: exposure.externalEntityId,
    connectionKind: exposure.connectionKind,
    enabled: exposure.enabled,
    dispatchable: exposure.dispatchable,
    allowedAgentIds: [...exposure.allowedAgentIds],
  };
}

export interface ToolPolicyView {
  readonly toolId: string;
  readonly toolName: string;
  readonly exposed: boolean;
  readonly minIdentityMode: string;
  readonly scopeLabels: readonly string[];
  readonly allowedPatIds: readonly string[];
  /** Null on a synthesized denial — nothing was ever written. */
  readonly addedAt: Date | null;
  readonly lastReviewedAt: Date | null;
}

export function toToolPolicyView(policy: EntityToolPolicy): ToolPolicyView {
  return {
    toolId: policy.toolId,
    toolName: policy.toolName,
    exposed: policy.effect === "ALLOW",
    minIdentityMode: policy.minIdentityMode,
    scopeLabels: [...policy.scopeLabels],
    allowedPatIds: [...policy.allowedPatIds],
    addedAt: policy.addedAt,
    lastReviewedAt: policy.lastReviewedAt,
  };
}

export interface McpSurfaceView {
  readonly entityId: string;
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly identityMode: string;
  readonly toolAllowlist: readonly string[];
  readonly redirectUriAllowlist: readonly string[];
  readonly rateLimitPerMinute: number;
  readonly injectMcpContext: boolean;
  readonly updatedAt: Date;
}

export function toMcpSurfaceView(config: EntityMcpConfig, ready: boolean): McpSurfaceView {
  return {
    entityId: config.entityId,
    enabled: config.enabled,
    ready,
    identityMode: config.identityMode,
    toolAllowlist: [...config.toolAllowlist],
    redirectUriAllowlist: [...config.redirectUriAllowlist],
    rateLimitPerMinute: config.rateLimitPerMinute,
    injectMcpContext: config.injectMcpContext,
    updatedAt: config.updatedAt,
  };
}

export interface ToolHealthView {
  readonly toolId: string;
  readonly externalEntityId: string | null;
  readonly lastCalledAt: Date | null;
  readonly lastStatus: string | null;
  /** Consecutive failures. Zero means the last call worked. */
  readonly failCount: number;
  readonly totalCalls: number;
  readonly totalFailures: number;
  readonly avgLatencyMs: number | null;
  /** Declared by the schema, never written. Always null. */
  readonly p95LatencyMs: number | null;
}

export function toToolHealthView(health: ToolHealth): ToolHealthView {
  return {
    toolId: health.toolId,
    externalEntityId: health.entityExternalId,
    lastCalledAt: health.lastCalledAt,
    lastStatus: health.lastStatus,
    failCount: health.failCount,
    totalCalls: health.totalCalls,
    totalFailures: health.totalFailures,
    avgLatencyMs: health.avgLatencyMs,
    p95LatencyMs: health.p95LatencyMs,
  };
}

export interface ToolAuditView {
  readonly auditId: string;
  readonly toolId: string | null;
  readonly toolName: string;
  readonly agentId: string | null;
  readonly threadId: string | null;
  readonly endUserId: string | null;
  readonly traceId: string | null;
  readonly status: string;
  readonly error: string | null;
  readonly latencyMs: number;
  /** Canonical `Decimal(18, 6)` cents. Never a number. */
  readonly costCents: string | null;
  readonly source: string | null;
  readonly createdAt: Date;
}

/**
 * The audit view carries NO `arguments` and NO `result`.
 *
 * Both are sealed at rest and both routinely hold the user's own words and rows
 * from a customer's backend. Rendering them belongs to a surface that has
 * already decided who is looking and has asked `secrets` to open the envelope;
 * putting them on the ordinary listing view would make that decision by
 * default, for every caller of the list endpoint at once.
 */
export function toToolAuditView(entry: AuditEntry): ToolAuditView {
  return {
    auditId: entry.toolCallAuditId,
    toolId: entry.toolId,
    toolName: entry.toolName,
    agentId: entry.agentId,
    threadId: entry.threadId,
    endUserId: entry.endUserId,
    traceId: entry.traceId,
    status: entry.status,
    error: entry.error,
    latencyMs: entry.latencyMs,
    costCents: entry.costCents,
    source: entry.envelope.source,
    createdAt: entry.createdAt,
  };
}

export interface PermissionView {
  readonly state: string;
  readonly tier: number;
  readonly reason: string;
}

export function toPermissionView(decision: PermissionDecision): PermissionView {
  return { state: decision.state, tier: decision.tier, reason: decision.reason };
}
