// Row -> record mapping for the ten `tools` rows, and the one place a column is
// trusted or refused.
//
// Every function here is PURE and takes a structural row type rather than a
// generated one, for the reason `./mapping.ts` gives: a suite that could only
// run after `prisma generate` is a suite nobody runs. The structural types are
// checked against the generated ones where the stores call these functions, so a
// schema change still breaks the build — at the call site rather than here.
//
// UNION COLUMNS ARE VALIDATED, NOT CAST. Five of this context's unions live in
// plain `String` columns — `EntityMcpClient.transport`, `EntityMcpConfig`'s and
// `EntityToolPolicy`'s identity modes, `ToolHealth.lastStatus` and
// `Entity.connectionKind` — so nothing but this file stands between a value an
// older binary wrote and a dispatch decision made on it. `readUnion` refuses
// instead, with the column named, because "this row is not readable by this
// binary" is an operational event during an expand/contract window and a silent
// cast is not.
//
// THREE COLUMNS HOLD LESS THAN THE DOMAIN RECORD DOES, AND EACH IS A FINDING
// RATHER THAN A GAP THIS FILE PAPERS OVER:
//
//   `Tool.category` is NULLABLE and `Tool.category` in the domain is not. A row
//   written before the registry inferred a category reads back as `""`, which is
//   what `inferToolCategory` produces for an unclassifiable name anyway.
//
//   `EntityToolPolicy` has no `toolName` column. The name is the joined
//   `Tool.name`, so a policy is only readable WITH its tool — which is also why
//   `Tool.id` is the join key and the name never becomes one.
//
//   `EntityMcpClient` has no `credentialName` column. It holds a `credentialId`
//   and the NAME is `Credential.name`, which `secrets` owns. It is read through
//   the same connection because `resolveTransport` fails closed without it.
//
// THE AUDIT ENVELOPE IS THE FOURTH AND THE LARGEST. See `./tools-audit.ts`.

import type {
  AgentToolDefaultPolicy,
  CallStatus,
  ConnectionKind,
  CredentialId,
  CredentialName,
  EntityId,
  EntityMcpClient,
  EntityMcpConfig,
  EntityToolPolicy,
  EntityToolPolicyId,
  EnvironmentId,
  ExposureId,
  ExternalEntityId,
  HealthOutcome,
  IdentityMode,
  McpIdentityProvider,
  McpTransport,
  PolicyEffect,
  SchemaHash,
  Tool,
  ToolExposure,
  ToolHealth,
  ToolHealthId,
  ToolId,
  ToolKind,
  ToolName,
} from "@platos/context-tools/application/ports/index.js";
import {
  AGENT_TOOL_DEFAULT_POLICIES,
  asToolsIdentifier,
  CALL_STATUSES,
  CONNECTION_KINDS,
  decodeLabels,
  dispatchabilityOf,
  HEALTH_OUTCOMES,
  IDENTITY_MODES,
  MCP_TRANSPORTS,
  normalizeHeaderTemplate,
  POLICY_EFFECTS,
  TOOL_KINDS,
} from "@platos/context-tools/application/ports/index.js";

/** A stored union member this binary does not recognise. */
export const UNKNOWN_TOOLS_UNION_MEMBER = "tools.row.unknown_union_member";

export class UnreadableToolsRowError extends Error {
  readonly code: string;
  readonly column: string;

  constructor(column: string, value: string) {
    super(`${column} holds ${JSON.stringify(value)}, which this binary does not recognise`);
    this.name = "UnreadableToolsRowError";
    this.code = UNKNOWN_TOOLS_UNION_MEMBER;
    this.column = column;
  }
}

/** Narrow a stored string to a domain union, or refuse naming the column. */
export function readUnion<Member extends string>(
  column: string,
  members: readonly Member[],
  value: string,
): Member {
  const found = members.find((member) => member === value);
  if (found === undefined) throw new UnreadableToolsRowError(column, value);
  return found;
}

/**
 * A `Json` column as an object, or `{}`.
 *
 * An ARRAY is rejected here rather than spread, because `typeof [] === "object"`
 * and a caller that spread one would silently produce `{ "0": … }` header names.
 * `null` reaches this on a nullable column and on a row written before the
 * column had a default.
 */
export function readJsonObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

/** A `Json` column as an array of objects, or `[]`. */
export function readJsonObjects(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Readonly<Record<string, unknown>> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

/** `{ header: template }`, with every non-string value dropped. See branding. */
export function readStringMap(value: unknown): Readonly<Record<string, string>> {
  const entries = Object.entries(readJsonObject(value)).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
}

// ---- Tool ----------------------------------------------------------------

export interface ToolRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: string;
  readonly paramSchema: unknown;
  readonly category: string | null;
  readonly schemaHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toTool(row: ToolRow): Tool {
  return {
    toolId: asToolsIdentifier<ToolId>(row.id),
    name: asToolsIdentifier<ToolName>(row.name),
    description: row.description,
    kind: readUnion<ToolKind>("Tool.kind", TOOL_KINDS, row.kind),
    paramSchema: readJsonObject(row.paramSchema),
    // Nullable column, non-null field. See the header.
    category: row.category ?? "",
    schemaHash: asToolsIdentifier<SchemaHash>(row.schemaHash),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---- EnvironmentEntityTool ------------------------------------------------

/** One exposure row with the four joins a resolved `ToolExposure` needs. */
export interface ExposureRow {
  readonly id: string;
  readonly environmentId: string;
  readonly entityId: string;
  readonly enabled: boolean;
  readonly callbackUrl: string | null;
  readonly tool: ToolRow;
  readonly entity: {
    readonly externalId: string;
    readonly connectionKind: string;
    readonly mcpClient: { readonly entityId: string } | null;
    readonly mcpConfig: { readonly injectMcpContext: boolean } | null;
  };
}

/**
 * `allowedAgentIds` is supplied rather than derived here.
 *
 * It is a fold over the environment's WHOLE binding set, not a property of this
 * row, and computing it per row is the N+1 the statement suite pins against.
 */
export function toExposure(row: ExposureRow, allowedAgentIds: readonly string[]): ToolExposure {
  const tool = toTool(row.tool);
  const connectionKind = readUnion<ConnectionKind>(
    "Entity.connectionKind",
    CONNECTION_KINDS,
    row.entity.connectionKind,
  );
  return {
    exposureId: asToolsIdentifier<ExposureId>(row.id),
    environmentId: asToolsIdentifier<EnvironmentId>(row.environmentId),
    entityId: asToolsIdentifier<EntityId>(row.entityId),
    externalEntityId: asToolsIdentifier<ExternalEntityId>(row.entity.externalId),
    toolId: tool.toolId,
    toolName: tool.name,
    description: tool.description,
    paramSchema: tool.paramSchema,
    category: tool.category,
    // `""` and never null, which is what `hasPersistentCallback` is written
    // against and what the exposure record's own comment promises.
    callbackUrl: row.callbackUrl ?? "",
    connectionKind,
    enabled: row.enabled,
    // The DOMAIN rule, applied — not a second copy of it. A stored flag would
    // strand every tool of a backend that crashed.
    dispatchable: dispatchabilityOf({
      connectionKind,
      callbackUrl: row.callbackUrl,
      hasMcpClient: row.entity.mcpClient !== null,
    }),
    allowedAgentIds: allowedAgentIds.map((agentId) => asToolsIdentifier(agentId)),
    injectMcpContext: row.entity.mcpConfig?.injectMcpContext ?? false,
  };
}

// ---- EntityToolPolicy -----------------------------------------------------

export interface EntityPolicyRow {
  readonly id: string;
  readonly environmentId: string;
  readonly entityId: string;
  readonly toolId: string;
  readonly effect: string;
  readonly minIdentityMode: string;
  readonly scopeLabels: readonly string[];
  readonly addedBy: string;
  readonly addedAt: Date;
  readonly lastReviewedAt: Date | null;
  readonly tool: { readonly name: string };
}

export function toEntityPolicy(row: EntityPolicyRow): EntityToolPolicy {
  // ONE COLUMN, TWO FIELDS. `scopeLabels` carries both the free-form labels and
  // the `platos:pat:` ids, and `decodeLabels` is the domain rule that splits
  // them. Splitting them here by hand would be a second copy of a prefix.
  const decoded = decodeLabels(row.scopeLabels);
  return {
    entityToolPolicyId: asToolsIdentifier<EntityToolPolicyId>(row.id),
    environmentId: asToolsIdentifier<EnvironmentId>(row.environmentId),
    entityId: asToolsIdentifier<EntityId>(row.entityId),
    toolId: asToolsIdentifier<ToolId>(row.toolId),
    toolName: asToolsIdentifier<ToolName>(row.tool.name),
    effect: readUnion<PolicyEffect>("EntityToolPolicy.effect", POLICY_EFFECTS, row.effect),
    minIdentityMode: readUnion<IdentityMode>(
      "EntityToolPolicy.minIdentityMode",
      IDENTITY_MODES,
      row.minIdentityMode,
    ),
    scopeLabels: decoded.scopeLabels,
    allowedPatIds: decoded.allowedPatIds,
    addedBy: asToolsIdentifier(row.addedBy),
    addedAt: row.addedAt,
    lastReviewedAt: row.lastReviewedAt,
  };
}

// ---- EntityMcpConfig / EntityMcpClient ------------------------------------

export interface McpConfigRow {
  readonly entityId: string;
  readonly enabled: boolean;
  readonly identityMode: string;
  readonly identityProviders: unknown;
  readonly branding: unknown;
  readonly toolAllowlist: readonly string[];
  readonly redirectUriAllowlist: readonly string[];
  readonly rateLimitPerMinute: number;
  readonly injectMcpContext: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toIdentityProvider(raw: Readonly<Record<string, unknown>>): McpIdentityProvider | null {
  const kind = raw.kind;
  if (kind !== "bearer" && kind !== "oidc") return null;
  return {
    kind,
    issuer: typeof raw.issuer === "string" ? raw.issuer : null,
    audience: typeof raw.audience === "string" ? raw.audience : null,
  };
}

export function toMcpConfig(row: McpConfigRow): EntityMcpConfig {
  return {
    entityId: asToolsIdentifier<EntityId>(row.entityId),
    enabled: row.enabled,
    identityMode: readUnion<IdentityMode>(
      "EntityMcpConfig.identityMode",
      IDENTITY_MODES,
      row.identityMode,
    ),
    // A descriptor whose `kind` this binary does not know is DROPPED rather
    // than refused: the column is a list of things a caller may authenticate
    // with, and one unknown entry must not make the whole surface unreadable.
    identityProviders: readJsonObjects(row.identityProviders)
      .map(toIdentityProvider)
      .filter((provider): provider is McpIdentityProvider => provider !== null),
    branding: readStringMap(row.branding),
    toolAllowlist: row.toolAllowlist.map((name) => asToolsIdentifier<ToolName>(name)),
    redirectUriAllowlist: [...row.redirectUriAllowlist],
    rateLimitPerMinute: row.rateLimitPerMinute,
    injectMcpContext: row.injectMcpContext,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface McpClientRow {
  readonly entityId: string;
  readonly transport: string;
  readonly url: string | null;
  readonly credentialId: string | null;
  readonly headersTemplate: unknown;
  readonly lastDiscoveryAt: Date | null;
  readonly discoveryError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** `Credential.name`, joined. Null when the credential was deleted. */
  readonly credential: { readonly name: string } | null;
}

export function toMcpClient(row: McpClientRow): EntityMcpClient {
  const credentialName =
    row.credential === null ? null : asToolsIdentifier<CredentialName>(row.credential.name);
  return {
    entityId: asToolsIdentifier<EntityId>(row.entityId),
    transport: readUnion<McpTransport>("EntityMcpClient.transport", MCP_TRANSPORTS, row.transport),
    url: row.url,
    credentialId:
      row.credentialId === null ? null : asToolsIdentifier<CredentialId>(row.credentialId),
    credentialName,
    // The domain rule again: the default `Authorization: Bearer {{secret}}` is
    // conditional on there BEING a credential, and that condition is the joined
    // name rather than the raw column, because `ON DELETE SET NULL` leaves a
    // client whose id is gone and whose template must not be invented.
    headersTemplate: normalizeHeaderTemplate(row.headersTemplate, credentialName !== null),
    lastDiscoveryAt: row.lastDiscoveryAt,
    discoveryError: row.discoveryError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---- ToolHealth -----------------------------------------------------------

export interface ToolHealthRow {
  readonly id: string;
  readonly environmentId: string;
  readonly toolId: string;
  readonly entityExternalId: string | null;
  readonly lastCalledAt: Date | null;
  readonly lastStatus: string | null;
  readonly failCount: number;
  readonly totalCalls: number;
  readonly totalFailures: number;
  readonly avgLatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly updatedAt: Date;
}

export function toHealth(row: ToolHealthRow): ToolHealth {
  return {
    toolHealthId: asToolsIdentifier<ToolHealthId>(row.id),
    environmentId: asToolsIdentifier<EnvironmentId>(row.environmentId),
    toolId: asToolsIdentifier<ToolId>(row.toolId),
    entityExternalId:
      row.entityExternalId === null
        ? null
        : asToolsIdentifier<ExternalEntityId>(row.entityExternalId),
    lastCalledAt: row.lastCalledAt,
    lastStatus:
      row.lastStatus === null
        ? null
        : readUnion<HealthOutcome>("ToolHealth.lastStatus", HEALTH_OUTCOMES, row.lastStatus),
    failCount: row.failCount,
    totalCalls: row.totalCalls,
    totalFailures: row.totalFailures,
    avgLatencyMs: row.avgLatencyMs,
    p95LatencyMs: row.p95LatencyMs,
    updatedAt: row.updatedAt,
  };
}

// ---- shared narrowings ----------------------------------------------------

export function readCallStatus(column: string, value: string): CallStatus {
  return readUnion<CallStatus>(column, CALL_STATUSES, value);
}

export function readEffect(column: string, value: string): PolicyEffect {
  return readUnion<PolicyEffect>(column, POLICY_EFFECTS, value);
}

export function readDefaultPolicy(value: string): AgentToolDefaultPolicy {
  return readUnion<AgentToolDefaultPolicy>(
    "AgentVersion.toolDefaultPolicy",
    AGENT_TOOL_DEFAULT_POLICIES,
    value,
  );
}
