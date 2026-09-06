// One scenario for `ToolsRepository`, so the in-memory double and this adapter
// can be asked the SAME questions and their answers compared verbatim.
//
// It is the same instrument tranche 1 built for the repository, tranche 2 for
// the identity-access stores and tranche 3 for the five non-repository ports.
// Pointing it here earns its keep for a reason particular to this port: the
// double `packages/contexts/tools` ships is UNUSUALLY good — its own header
// lists four store constraints it enforces on purpose — and every use-case suite
// in that context is green against it. A double that convincing is exactly the
// one worth differencing against a database.
//
// WHAT IS NORMALISED, AND WHY EACH.
//
//   IDENTIFIERS. The double mints `tool-1`, `exposure-1`, `orgpolicy-1`; the
//   adapter mints uuids the database chose. No minted id is recorded. What IS
//   recorded is what both must be true of — that a second `upsertTool` on one
//   fingerprint returns the SAME row, that a page's ids are disjoint from the
//   next page's, that a deleted policy stops resolving.
//
//   INSTANTS THE STORE CHOOSES. `Tool.createdAt`, `EntityMcpConfig.updatedAt`
//   and `OrganizationMcpPolicy.createdAt` are column defaults and `@updatedAt`
//   maintenance, so the database picks them and the double picks 2026-01-01. An
//   instant the CALLER supplies — `ToolCall.createdAt`, `AuditEntry.createdAt`,
//   `EntityToolPolicy.addedAt` — is recorded, because both stores must keep it.
//
//   `ToolExposure.externalEntityId`. The double writes the literal `entity-1`
//   for a row it is minting; the adapter reads `Entity.externalId`. The VALUE
//   cannot agree, so what is recorded is the structural fact that every exposure
//   of one entity carries one external id.
//
// FOUR PROPERTIES ARE DELIBERATELY LEFT OUT and asserted separately in
// `tools-conformance.integration.test.ts`, because the two stores DISAGREE and
// each disagreement is a finding rather than noise: `replaceExposures` and an
// operator's off-switch, `EntityToolPolicy.addedAt` when it is null, the
// `ToolHealth` row whose `entityExternalId` is null, and the four `AuditQuery`
// filters the double does not implement. Recording them here would have made
// this scenario red for reasons that are not the adapter's; recording them
// nowhere would have lost them.

import type {
  ActorId,
  AgentId,
  AuditEntry,
  CredentialId,
  CredentialName,
  EndUserId,
  EntityId,
  EntityMcpClient,
  EntityMcpConfig,
  EntityToolPolicy,
  EntityToolPolicyId,
  EnvironmentScope,
  ExposureId,
  ExternalEntityId,
  Result,
  SchemaHash,
  StepId,
  ThreadId,
  ToolCall,
  ToolCallAuditId,
  ToolCallId,
  ToolExposure,
  ToolHealth,
  ToolHealthId,
  ToolId,
  ToolName,
  ToolsRepository,
} from "@platos/context-tools/application/ports/index.js";
import { asToolsIdentifier } from "@platos/context-tools/application/ports/index.js";

import {
  auditShape,
  callShape,
  exposureShape,
  healthShape,
  mcpClientShape,
  mcpConfigShape,
  refusal,
} from "./tools-conformance-shapes.js";

/** Every identifier the scenario needs, so each store can use its own. */
export interface ToolsConformanceIds {
  readonly scope: EnvironmentScope;
  /** Resolves to a real environment under a DIFFERENT project. Must refuse. */
  readonly foreignScope: EnvironmentScope;
  readonly entityId: EntityId;
  readonly stepId: string;
  readonly endUserId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly credentialId: string;
  readonly credentialName: string;
  /** An exposure id that names nothing. `setExposureEnabled` must refuse it. */
  readonly absentExposureId: ExposureId;
}

/** The instant every caller-supplied timestamp in the scenario carries. */
export const TOOLS_AT = new Date("2026-05-01T09:00:00.000Z");

export type ToolsObservation = Record<string, unknown>;

const CALLBACK = "https://backend.example.test/hooks/tools";

/** The two fingerprints the scenario registers. Sorted names, on purpose. */
const ALPHA = { name: "alpha.search", hash: "0123456789abcdef" };
const BETA = { name: "beta.write", hash: "fedcba9876543210" };

function toolName(value: string): ToolName {
  return asToolsIdentifier<ToolName>(value);
}

function schemaHash(value: string): SchemaHash {
  return asToolsIdentifier<SchemaHash>(value);
}

function value<Value>(result: Result<Value>): Value {
  if (!result.ok) throw new Error(`the scenario requires this to succeed: ${result.error.code}`);
  return result.value;
}

export async function runToolsConformance(
  repository: ToolsRepository,
  ids: ToolsConformanceIds,
): Promise<ToolsObservation> {
  const { scope, entityId } = ids;
  const observed: ToolsObservation = {};

  // --- Tool: installation-global, content-addressed, never updated ----------
  observed.fingerprintBeforeMint = await repository
    .findToolByFingerprint(toolName(ALPHA.name), schemaHash(ALPHA.hash))
    .then((result) => value(result));

  const alpha = value(
    await repository.upsertTool({
      name: toolName(ALPHA.name),
      description: "search the alpha corpus",
      paramSchema: { type: "object", properties: { q: { type: "string" } } },
      category: "search",
      schemaHash: schemaHash(ALPHA.hash),
    }),
  );
  observed.mintedTool = {
    name: alpha.name,
    description: alpha.description,
    kind: alpha.kind,
    category: alpha.category,
    schemaHash: alpha.schemaHash,
    paramSchema: alpha.paramSchema,
  };

  const alphaAgain = value(
    await repository.upsertTool({
      name: toolName(ALPHA.name),
      // A DIFFERENT description under the SAME fingerprint. The port says
      // `upsertTool` is find-or-create and never an update, so the second call
      // must answer from the row that exists and leave its description alone.
      description: "a description the store must ignore",
      paramSchema: { type: "object" },
      category: "ignored",
      schemaHash: schemaHash(ALPHA.hash),
    }),
  );
  observed.reMintIsTheSameRow = alphaAgain.toolId === alpha.toolId;
  observed.reMintKeptDescription = alphaAgain.description === alpha.description;

  const beta = value(
    await repository.upsertTool({
      name: toolName(BETA.name),
      description: "write to the beta store",
      paramSchema: { type: "object", properties: { body: { type: "string" } } },
      category: "write",
      schemaHash: schemaHash(BETA.hash),
    }),
  );
  observed.fingerprintAfterMint = value(
    await repository.findToolByFingerprint(toolName(BETA.name), schemaHash(BETA.hash)),
  )?.name;
  observed.findToolsNames = value(await repository.findTools([alpha.toolId, beta.toolId]))
    .map((tool) => tool.name)
    .sort();
  observed.findToolsEmpty = value(await repository.findTools([])).length;

  // --- EnvironmentEntityTool: the dispatch matrix ---------------------------
  observed.exposuresBeforeRegistration = value(await repository.listExposures(scope)).length;

  const registered = value(
    await repository.replaceExposures({
      scope,
      entityId,
      callbackUrl: CALLBACK,
      toolIds: [beta.toolId, alpha.toolId],
    }),
  );
  observed.registered = registered.map(exposureShape);
  observed.registeredOneExternalId =
    new Set(registered.map((exposure) => exposure.externalEntityId)).size === 1;
  observed.entityExposureCount = value(
    await repository.listEntityExposures(scope, entityId),
  ).length;

  const firstPage = value(
    await repository.pageExposures(scope, { limit: 1, offset: 0, entityId: null, search: null }),
  );
  const secondPage = value(
    await repository.pageExposures(scope, { limit: 1, offset: 1, entityId: null, search: null }),
  );
  observed.pageTotals = [firstPage.total, secondPage.total];
  observed.pageNames = [
    firstPage.items.map((item) => item.toolName),
    secondPage.items.map((item) => item.toolName),
  ];
  observed.pagesAreDisjoint =
    firstPage.items[0]?.exposureId !== secondPage.items[0]?.exposureId;
  observed.searchNames = value(
    await repository.pageExposures(scope, {
      limit: 10,
      offset: 0,
      entityId: null,
      search: "BETA",
    }),
  ).items.map((item) => item.toolName);
  observed.entityFilterCount = value(
    await repository.pageExposures(scope, { limit: 10, offset: 0, entityId, search: null }),
  ).total;

  const disabled = value(
    await repository.setExposureEnabled(
      scope,
      registered[0]?.exposureId ?? ids.absentExposureId,
      false,
    ),
  );
  observed.disabledExposure = { toolName: disabled.toolName, enabled: disabled.enabled };
  observed.setEnabledOnAbsentExposure = refusal(
    await repository.setExposureEnabled(scope, ids.absentExposureId, true),
  );
  // Switched back on, so the rest of the scenario sees the state it expects.
  await repository.setExposureEnabled(scope, disabled.exposureId, true);

  // A SECOND registration that drops one tool. "Anything absent is deleted,
  // which is the point" — the port's own words.
  observed.afterNarrowing = value(
    await repository.replaceExposures({
      scope,
      entityId,
      callbackUrl: CALLBACK,
      toolIds: [beta.toolId],
    }),
  ).map((exposure) => exposure.toolName);
  observed.exposuresAfterNarrowing = value(await repository.listExposures(scope)).length;

  // --- AgentToolPolicy: read-only here -------------------------------------
  const bindings = value(await repository.listAgentPolicyBindings(scope));
  observed.bindingDefaults = bindings.map((binding) => binding.defaultPolicy);
  observed.bindingPolicyCounts = bindings.map((binding) => binding.policies.length);
  observed.unknownBinding = value(
    await repository.findAgentPolicyBinding(scope, "00000000-0000-4000-8000-0000000000ff"),
  );

  // --- EntityToolPolicy ----------------------------------------------------
  observed.entityPoliciesBefore = value(
    await repository.listEntityToolPolicies(scope, entityId),
  ).length;

  const policy: EntityToolPolicy = {
    entityToolPolicyId: asToolsIdentifier<EntityToolPolicyId>("<minted>"),
    environmentId: scope.environmentId,
    entityId,
    toolId: beta.toolId,
    toolName: beta.name,
    effect: "ALLOW",
    minIdentityMode: "bearer",
    scopeLabels: ["tools:write"],
    allowedPatIds: ["pat-1"],
    addedBy: asToolsIdentifier<ActorId>("system"),
    addedAt: TOOLS_AT,
    lastReviewedAt: null,
  };
  const writtenPolicy = value(await repository.upsertEntityToolPolicy(policy));
  observed.writtenPolicy = {
    toolName: writtenPolicy.toolName,
    effect: writtenPolicy.effect,
    minIdentityMode: writtenPolicy.minIdentityMode,
    scopeLabels: [...writtenPolicy.scopeLabels],
    allowedPatIds: [...writtenPolicy.allowedPatIds],
    addedBy: writtenPolicy.addedBy,
    addedAt: writtenPolicy.addedAt?.toISOString() ?? null,
    lastReviewedAt: writtenPolicy.lastReviewedAt,
  };
  const flipped = value(
    await repository.upsertEntityToolPolicy({ ...policy, effect: "DENY", scopeLabels: [] }),
  );
  observed.flippedPolicy = {
    effect: flipped.effect,
    scopeLabels: [...flipped.scopeLabels],
    allowedPatIds: [...flipped.allowedPatIds],
  };
  observed.entityPoliciesAfter = value(
    await repository.listEntityToolPolicies(scope, entityId),
  ).length;

  // --- OrganizationMcpPolicy ----------------------------------------------
  observed.organizationPoliciesBefore = value(
    await repository.listOrganizationPolicies(scope),
  ).length;
  const orgPolicy = value(await repository.upsertOrganizationPolicy(scope, "beta.*", "DENY"));
  observed.organizationPolicy = { pattern: orgPolicy.pattern, effect: orgPolicy.effect };
  const reflipped = value(await repository.upsertOrganizationPolicy(scope, "beta.*", "ALLOW"));
  observed.organizationPolicyRewritten = {
    sameRow: reflipped.organizationMcpPolicyId === orgPolicy.organizationMcpPolicyId,
    effect: reflipped.effect,
    count: value(await repository.listOrganizationPolicies(scope)).length,
  };
  observed.organizationPolicyDeleted = value(
    await repository.deleteOrganizationPolicy(scope, orgPolicy.organizationMcpPolicyId),
  );
  observed.organizationPolicyDeletedTwice = value(
    await repository.deleteOrganizationPolicy(scope, orgPolicy.organizationMcpPolicyId),
  );

  // --- EntityMcpConfig / EntityMcpClient -----------------------------------
  observed.mcpConfigBefore = value(await repository.findMcpConfig(scope, entityId));
  const config: EntityMcpConfig = {
    entityId,
    enabled: true,
    identityMode: "bearer",
    identityProviders: [{ kind: "bearer", issuer: "https://issuer.example.test", audience: null }],
    branding: { displayName: "Alpha tools" },
    toolAllowlist: [beta.name],
    redirectUriAllowlist: ["https://app.example.test/cb"],
    rateLimitPerMinute: 120,
    injectMcpContext: true,
    createdAt: TOOLS_AT,
    updatedAt: TOOLS_AT,
  };
  const savedConfig = value(await repository.saveMcpConfig(scope, config));
  observed.savedMcpConfig = mcpConfigShape(savedConfig);
  observed.readBackMcpConfig = mcpConfigShape(
    value(await repository.findMcpConfig(scope, entityId)) as EntityMcpConfig,
  );

  observed.mcpClientBefore = value(await repository.findMcpClient(scope, entityId));
  const client: EntityMcpClient = {
    entityId,
    transport: "http",
    url: "https://mcp.example.test/sse",
    credentialId: asToolsIdentifier<CredentialId>(ids.credentialId),
    credentialName: asToolsIdentifier<CredentialName>(ids.credentialName),
    headersTemplate: { Authorization: "Bearer {{secret}}" },
    lastDiscoveryAt: TOOLS_AT,
    discoveryError: null,
    createdAt: TOOLS_AT,
    updatedAt: TOOLS_AT,
  };
  observed.savedMcpClient = mcpClientShape(value(await repository.saveMcpClient(scope, client)));
  observed.readBackMcpClient = mcpClientShape(
    value(await repository.findMcpClient(scope, entityId)) as EntityMcpClient,
  );

  // --- ToolCall ------------------------------------------------------------
  observed.stepCallsBefore = value(await repository.listStepCalls(scope, ids.stepId)).length;
  const call: ToolCall = {
    toolCallId: asToolsIdentifier<ToolCallId>("11111111-2222-4333-8444-555555555555"),
    stepId: asToolsIdentifier<StepId>(ids.stepId),
    toolId: beta.toolId,
    sequence: 1,
    toolName: beta.name,
    arguments: { body: "hello" },
    // A SCALAR result, which the json-root CHECK refuses and the record permits.
    result: 42,
    status: "SUCCEEDED",
    retryCount: 0,
    error: null,
    latencyMs: 17,
    startedAt: TOOLS_AT,
    completedAt: TOOLS_AT,
    createdAt: TOOLS_AT,
  };
  observed.savedCall = callShape(value(await repository.saveCall(scope, call)));
  observed.readBackCalls = value(await repository.listStepCalls(scope, ids.stepId)).map(callShape);

  // --- ToolHealth ----------------------------------------------------------
  observed.healthBefore = value(
    await repository.findHealth(scope, beta.toolId, asToolsIdentifier<ExternalEntityId>("entity-external")),
  );
  const health: ToolHealth = {
    toolHealthId: asToolsIdentifier<ToolHealthId>("22222222-3333-4444-8555-666666666666"),
    environmentId: scope.environmentId,
    toolId: beta.toolId,
    entityExternalId: asToolsIdentifier<ExternalEntityId>("entity-external"),
    lastCalledAt: TOOLS_AT,
    lastStatus: "failed",
    failCount: 1,
    totalCalls: 3,
    totalFailures: 1,
    avgLatencyMs: 22,
    p95LatencyMs: null,
    updatedAt: TOOLS_AT,
  };
  observed.savedHealth = healthShape(value(await repository.saveHealth(scope, health)));
  observed.readBackHealth = healthShape(
    value(
      await repository.findHealth(scope, beta.toolId, asToolsIdentifier<ExternalEntityId>("entity-external")),
    ) as ToolHealth,
  );

  // --- ToolCallAudit -------------------------------------------------------
  const entry: AuditEntry = {
    toolCallAuditId: asToolsIdentifier<ToolCallAuditId>("33333333-4444-4555-8666-777777777777"),
    environmentId: scope.environmentId,
    toolId: beta.toolId,
    toolName: beta.name,
    agentId: asToolsIdentifier<AgentId>(ids.agentId),
    threadId: asToolsIdentifier<ThreadId>(ids.threadId),
    endUserId: asToolsIdentifier<EndUserId>(ids.endUserId),
    traceId: "trace-1",
    arguments: { body: "hello" },
    result: { ok: true },
    error: null,
    status: "SUCCEEDED",
    latencyMs: 17,
    costCents: "1.5",
    envelope: {
      externalEntityId: asToolsIdentifier<ExternalEntityId>("entity-external"),
      endUserId: asToolsIdentifier<EndUserId>(ids.endUserId),
      actorUserId: asToolsIdentifier<ActorId>("actor-1"),
      spanId: "span-1",
      parentSpanId: null,
      source: "turn",
      mcpPrincipalId: "mcp:pat:1",
      mcpClientId: "client-1",
    },
    createdAt: TOOLS_AT,
  };
  observed.appendedAudit = auditShape(value(await repository.appendAudit(scope, entry)));
  observed.pagedAudit = value(
    await repository.pageAudit(scope, {
      sinceDays: 36_500,
      limit: 10,
      offset: 0,
      toolName: null,
      agentId: null,
      threadId: null,
      status: null,
    }),
  ).map(auditShape);
  observed.pagedAuditByName = value(
    await repository.pageAudit(scope, {
      sinceDays: 36_500,
      limit: 10,
      offset: 0,
      toolName: toolName("nothing.matches"),
      agentId: null,
      threadId: null,
      status: null,
    }),
  ).length;

  // --- the tenant clause ---------------------------------------------------
  //
  // The forged scope names an environment that EXISTS and a project that is not
  // its parent. A leaf-keyed store answers it; both of these refuse, with the
  // same reason, which is the whole point of recording it here.
  observed.foreignListExposures = refusal(await repository.listExposures(ids.foreignScope));
  observed.foreignPageAudit = refusal(
    await repository.pageAudit(ids.foreignScope, {
      sinceDays: 30,
      limit: 10,
      offset: 0,
      toolName: null,
      agentId: null,
      threadId: null,
      status: null,
    }),
  );
  observed.foreignSaveHealth = refusal(await repository.saveHealth(ids.foreignScope, health));
  return observed;
}

/** The two tool ids the scenario mints, for a caller that needs to seed. */
export const CONFORMANCE_FINGERPRINTS = Object.freeze({ ALPHA, BETA });
