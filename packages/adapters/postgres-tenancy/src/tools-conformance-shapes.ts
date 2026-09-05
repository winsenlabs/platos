// The projections the conformance scenario records, and NOTHING else.
//
// SPLIT OUT OF `./tools-conformance.ts` BECAUSE THE ADR M0.3 s6 BUDGET POINTED
// AT A REAL SEAM. The scenario is a sequence of calls; these are the decisions
// about WHICH FIELDS OF AN ANSWER TWO STORES MUST AGREE ON. Every omission below
// is a normalisation with a reason, and gathering them here is what lets a
// reviewer read the whole list of what is NOT compared without reading the
// scenario that produced it.
//
// WHAT IS OMITTED, AND WHY.
//
//   Every minted identifier. `Tool.id`, `EnvironmentEntityTool.id`,
//   `OrganizationMcpPolicy.id`, `ToolHealth.id` — the double counts and the
//   database mints uuids. Structural facts about them are recorded instead.
//
//   Every instant the STORE chooses. `createdAt` on a `Tool`, `updatedAt` on an
//   `EntityMcpConfig` or a `ToolHealth` — column defaults and `@updatedAt`
//   triggers. An instant the CALLER supplies is recorded, because both stores
//   owe it back unchanged.
//
//   `ToolExposure.externalEntityId`, `environmentId` and `entityId`. The first
//   is the literal `entity-1` in the double and a real `Entity.externalId` here;
//   the other two are the scope, restated.

import type {
  AuditEntry,
  EntityMcpClient,
  EntityMcpConfig,
  Result,
  ToolCall,
  ToolExposure,
  ToolHealth,
} from "@platos/context-tools/application/ports/index.js";

/** A refusal reduced to the two things both stores must agree on. */
export function refusal(result: Result<unknown>): unknown {
  if (result.ok) return "<accepted>";
  return { code: result.error.code, reason: result.error.details.reason ?? null };
}

/** An exposure without the fields a store is entitled to choose. */
export function exposureShape(exposure: ToolExposure): unknown {
  return {
    toolName: exposure.toolName,
    description: exposure.description,
    category: exposure.category,
    callbackUrl: exposure.callbackUrl,
    connectionKind: exposure.connectionKind,
    enabled: exposure.enabled,
    dispatchable: exposure.dispatchable,
    allowedAgentIds: [...exposure.allowedAgentIds],
    injectMcpContext: exposure.injectMcpContext,
    paramSchema: exposure.paramSchema,
  };
}

export function mcpConfigShape(config: EntityMcpConfig): unknown {
  return {
    enabled: config.enabled,
    identityMode: config.identityMode,
    identityProviders: config.identityProviders.map((provider) => ({ ...provider })),
    branding: { ...config.branding },
    toolAllowlist: [...config.toolAllowlist],
    redirectUriAllowlist: [...config.redirectUriAllowlist],
    rateLimitPerMinute: config.rateLimitPerMinute,
    injectMcpContext: config.injectMcpContext,
  };
}

export function mcpClientShape(client: EntityMcpClient): unknown {
  return {
    transport: client.transport,
    url: client.url,
    credentialName: client.credentialName,
    headersTemplate: { ...client.headersTemplate },
    lastDiscoveryAt: client.lastDiscoveryAt?.toISOString() ?? null,
    discoveryError: client.discoveryError,
  };
}

export function callShape(call: ToolCall): unknown {
  return {
    sequence: call.sequence,
    toolName: call.toolName,
    arguments: call.arguments,
    result: call.result,
    status: call.status,
    retryCount: call.retryCount,
    error: call.error,
    latencyMs: call.latencyMs,
    startedAt: call.startedAt?.toISOString() ?? null,
    completedAt: call.completedAt?.toISOString() ?? null,
    createdAt: call.createdAt.toISOString(),
  };
}

export function healthShape(health: ToolHealth): unknown {
  return {
    entityExternalId: health.entityExternalId,
    lastCalledAt: health.lastCalledAt?.toISOString() ?? null,
    lastStatus: health.lastStatus,
    failCount: health.failCount,
    totalCalls: health.totalCalls,
    totalFailures: health.totalFailures,
    avgLatencyMs: health.avgLatencyMs,
    p95LatencyMs: health.p95LatencyMs,
  };
}

export function auditShape(entry: AuditEntry): unknown {
  return {
    toolName: entry.toolName,
    traceId: entry.traceId,
    arguments: entry.arguments,
    result: entry.result,
    error: entry.error,
    status: entry.status,
    latencyMs: entry.latencyMs,
    costCents: entry.costCents,
    envelope: { ...entry.envelope },
    createdAt: entry.createdAt.toISOString(),
  };
}

