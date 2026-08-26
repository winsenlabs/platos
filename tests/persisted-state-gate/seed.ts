import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  AgentVersionBucket,
  ApprovalStatus,
  CredentialKind,
  CredentialRootKeyRing,
  OperatorIdentityProvider,
  OrganizationRole,
  PlatosSecretStore,
  ModelRateSource,
  PrismaClient,
  ProjectRole,
  ToolKind,
  WorkStatus,
} from "@platos/tenancy-database";
import {
  canonicalOperatorScope,
  deterministicFixtureUuid,
  type CanonicalScopeKey,
} from "./fixture-contract";

const FIXTURE_TIMESTAMP = new Date("2026-08-24T00:00:00.000Z");
const AGENTS_PER_SCOPE = 20;
const TURNS_PER_THREAD = 60;
const TOOLS = 200;
const MEMORIES_PER_SCOPE = 192;
const DENSE_MEMORIES_PER_SCOPE = 96;
const GRAPH_ENTITIES = [71, 70] as const;
const POSTMAN_TEMPLATES_PER_SCOPE = 3;
const MCP_TOKENS_PER_SCOPE = 3;
const GATE_DATABASE_HOST = "127.0.0.1";
const GATE_DATABASE_PORT = "55432";
const GATE_REDIS_PORT = "56379";
const GATE_CLICKHOUSE_PORT = "58123";
const GATE_MINIO_PORT = "59001";

type ScopeKey = CanonicalScopeKey;
const deterministicUuid = deterministicFixtureUuid;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const outputPath = path.resolve(argument("--output") ?? "artifacts/win235/fixture-manifest.json");
if (process.env.WIN235_ALLOW_SEED !== "1") {
  throw new Error("Refusing WIN-235 seed without explicit WIN235_ALLOW_SEED=1");
}
if (process.env.NODE_ENV !== "test") {
  throw new Error("Refusing WIN-235 seed unless NODE_ENV=test");
}
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const clickhouseUrl = process.env.CLICKHOUSE_URL;
const minioUrl = process.env.MINIO_ENDPOINT;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the canonical WIN-235 fixture");
if (!redisUrl) throw new Error("REDIS_URL is required for the canonical WIN-235 fixture");
if (!clickhouseUrl) throw new Error("CLICKHOUSE_URL is required for the canonical WIN-235 fixture");
if (!minioUrl) throw new Error("MINIO_ENDPOINT is required for the canonical WIN-235 fixture");

function requireGateEndpoint(
  name: string,
  value: string,
  expected: { protocol: string; port: string; pathname?: string }
) {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== expected.protocol ||
    endpoint.hostname !== GATE_DATABASE_HOST ||
    endpoint.port !== expected.port ||
    (expected.pathname !== undefined && endpoint.pathname !== expected.pathname)
  ) {
    throw new Error(`${name} is not the allow-listed isolated WIN-235 endpoint`);
  }
  return endpoint;
}

const parsedDatabaseUrl = requireGateEndpoint("DATABASE_URL", databaseUrl, {
  protocol: "postgresql:",
  port: GATE_DATABASE_PORT,
  pathname: "/platos_control",
});
if (
  parsedDatabaseUrl.username !== "postgres" ||
  parsedDatabaseUrl.password !== "win235-postgres-evidence-password" ||
  parsedDatabaseUrl.searchParams.get("schema") !== "public"
) {
  throw new Error("DATABASE_URL does not identify the isolated WIN-235 database and schema");
}
requireGateEndpoint("REDIS_URL", redisUrl, {
  protocol: "redis:",
  port: GATE_REDIS_PORT,
  pathname: "",
});
requireGateEndpoint("CLICKHOUSE_URL", clickhouseUrl, {
  protocol: "http:",
  port: GATE_CLICKHOUSE_PORT,
  pathname: "/",
});
requireGateEndpoint("MINIO_ENDPOINT", minioUrl, {
  protocol: "http:",
  port: GATE_MINIO_PORT,
  pathname: "/",
});
if (
  process.env.CLICKHOUSE_USER !== "default" ||
  process.env.CLICKHOUSE_PASSWORD !== "win235-clickhouse-evidence-password"
) {
  throw new Error("ClickHouse credentials do not identify the isolated WIN-235 store");
}
if (
  process.env.MINIO_ACCESS_KEY !== "persisted-state-gate" ||
  process.env.MINIO_SECRET_KEY !== "persisted-state-gate-password" ||
  process.env.MINIO_BUCKET !== "platos-media" ||
  process.env.MINIO_REGION !== "us-east-1"
) {
  throw new Error("MinIO configuration does not identify the isolated WIN-235 bucket");
}

const database = new PrismaClient({ datasourceUrl: databaseUrl });

async function seedScope(
  key: ScopeKey,
  graphEntityCount: number,
  tools: Array<{ id: string; name: string }>
) {
  const canonicalScope = canonicalOperatorScope(key);
  const organizationId = canonicalScope.organizationId;
  const projectId = canonicalScope.projectId;
  const environmentId = canonicalScope.environmentId;
  const operatorId = canonicalScope.operatorId;
  const membershipId = deterministicUuid(key, "membership");
  const projectMembershipId = deterministicUuid(key, "project-membership");
  const endUserId = canonicalScope.endUserId;
  const endUserIdentityId = deterministicUuid(key, "end-user-identity");
  const entityId = canonicalScope.entityId;
  const entityExternalId = canonicalScope.entityExternalId;
  const clusterId = canonicalScope.clusterId;
  const threadId = canonicalScope.threadId;
  const jobId = canonicalScope.jobId;
  const externalUserId = canonicalScope.externalUserId;
  const agentIds = Array.from({ length: AGENTS_PER_SCOPE }, (_, index) =>
    deterministicUuid(key, "agent", index)
  );
  const versionIds = agentIds.map((_, index) => deterministicUuid(key, "agent-version", index));

  await database.user.create({
    data: {
      id: operatorId,
      email: `win235-${key}@example.test`,
      displayName: `WIN-235 ${key} operator`,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.operatorIdentity.create({
    data: {
      id: deterministicUuid(key, "operator-identity"),
      userId: operatorId,
      provider: OperatorIdentityProvider.MAGIC_LINK,
      subject: `win235-${key}@example.test`,
      providerEmail: `win235-${key}@example.test`,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.organization.create({
    data: {
      id: organizationId,
      slug: `win235-${key}`,
      name: `WIN-235 ${key}`,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.organizationMembership.create({
    data: {
      id: membershipId,
      organizationId,
      userId: operatorId,
      role: OrganizationRole.OWNER,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.project.create({
    data: {
      id: projectId,
      organizationId,
      slug: `win235-${key}-project`,
      name: `WIN-235 ${key} project`,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.projectMembership.create({
    data: {
      id: projectMembershipId,
      projectId,
      organizationMembershipId: membershipId,
      organizationId,
      role: ProjectRole.ADMIN,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.environment.create({
    data: {
      id: environmentId,
      projectId,
      slug: "development",
      name: "Development",
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.mcpToken.createMany({
    data: Array.from({ length: MCP_TOKENS_PER_SCOPE }, (_, index) => ({
      id: deterministicUuid(key, "mcp-token", index),
      environmentId,
      mintedByUserId: operatorId,
      name: `Dense MCP token ${key}-${index + 1}`,
      tokenHash: createHash("sha256")
        .update(`win235:${key}:mcp-token:${index + 1}`)
        .digest("hex"),
      permissions: ["agents.get", "agents.list"],
      tier: "scope",
      createdAt: new Date(FIXTURE_TIMESTAMP.getTime() + index),
    })),
  });
  await database.environmentProvider.create({
    data: { environmentId, providerId: "openai", enabled: true },
  });
  const fixtureAuthorization = {
    principalType: "operator",
    tier: "OPERATOR",
    access: "secret:mutate",
    environmentId,
    projectId,
    organizationId,
    actorUserId: operatorId,
    effectiveUserId: operatorId,
    organizationRole: OrganizationRole.OWNER,
    projectRole: ProjectRole.ADMIN,
  } as any;
  const fixtureSecrets = new PlatosSecretStore(
    database,
    new CredentialRootKeyRing({ activeVersion: 1, keys: { 1: "cc".repeat(32) } })
  );
  await fixtureSecrets.createProviderCredentialAndKey({
    authorization: fixtureAuthorization,
    provider: "openai",
    name: "OPENAI_API_KEY",
    plaintext: "win235-deterministic-fixture-key",
    label: "WIN-235 deterministic fixture",
    isDefault: true,
  });
  await fixtureSecrets.create({
    authorization: fixtureAuthorization,
    kind: CredentialKind.SECRET_REFERENCE,
    provider: "openai",
    name: "OPENAI_BASE_URL",
    plaintext: "http://provider-fixture:4010/v1",
  });
  await database.endUser.create({
    data: {
      id: endUserId,
      organizationId,
      displayName: `WIN-235 ${key} EndUser`,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.endUserIdentity.create({
    data: {
      id: endUserIdentityId,
      endUserId,
      organizationId,
      issuer: "platos:external",
      channel: "external",
      subject: externalUserId,
      profile: { fixture: "WIN-235", scope: key },
      verifiedAt: FIXTURE_TIMESTAMP,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.agent.createMany({
    data: agentIds.map((id, index) => ({
      id,
      projectId,
      name: `Dense Agent ${key}-${String(index + 1).padStart(2, "0")}`,
      slug: `dense-agent-${key}-${String(index + 1).padStart(2, "0")}`,
      description: "Canonical WIN-235 dense fixture",
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    })),
  });
  await database.agentVersion.createMany({
    data: versionIds.map((id, index) => ({
      id,
      agentId: agentIds[index],
      versionNumber: 1,
      model: "openai:fixture-model",
      systemPrompt: `WIN-235 deterministic Agent ${key}-${index + 1}`,
      maxSteps: 10,
      contextLimit: 1000,
      promptBlocks: [],
      dynamicBlocks: [],
      toolsBlockConfig: { mode: "direct", toolExposure: "meta" },
      modelRoutes: [{ label: "fixture", model: "openai:fixture-model", isDefault: true }],
      memoryConfig: index === 0 ? { __runtime: { visibility: "public-guest" } } : {},
      createdBy: operatorId,
      createdAt: FIXTURE_TIMESTAMP,
    })),
  });
  await database.agentCluster.create({
    data: {
      id: clusterId,
      environmentId,
      name: `Dense Cluster ${key}`,
      slug: `dense-cluster-${key}`,
      metadata: { fixture: "WIN-235" },
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.agentBinding.createMany({
    data: agentIds.map((agentId, index) => ({
      id: deterministicUuid(key, "agent-binding", index),
      environmentId,
      agentId,
      activeAgentVersionId: versionIds[index],
      clusterId: index % 2 === 0 ? clusterId : null,
      createdAt: new Date(FIXTURE_TIMESTAMP.getTime() + index),
      updatedAt: new Date(FIXTURE_TIMESTAMP.getTime() + index),
    })),
  });
  await database.postmanTemplate.createMany({
    data: Array.from({ length: POSTMAN_TEMPLATES_PER_SCOPE }, (_, index) => ({
      id: deterministicUuid(key, "postman-template", index),
      environmentId,
      agentId: agentIds[0],
      name: `Dense Postman template ${key}-${index + 1}`,
      simulateUserId: endUserId,
      sessionContext: { fixture: "WIN-235", ordinal: index + 1 },
      createdBy: operatorId,
      isDefault: index === 0,
      createdAt: new Date(FIXTURE_TIMESTAMP.getTime() + index),
      updatedAt: new Date(FIXTURE_TIMESTAMP.getTime() + index),
    })),
  });
  const executablePostmanTargets = await database.postmanTemplate.findMany({
    where: { environmentId, agentId: agentIds[0] },
    select: { simulateUserId: true },
  });
  if (
    executablePostmanTargets.length !== POSTMAN_TEMPLATES_PER_SCOPE ||
    executablePostmanTargets.some(({ simulateUserId }) => simulateUserId !== endUserId)
  ) {
    throw new Error(
      "WIN-235 Postman templates must target the canonical scoped EndUser UUID"
    );
  }
  const [smallAgentPage, denseAgentPage] = await Promise.all(
    [5, 10].map((take) =>
      database.agentBinding.findMany({
        where: { environmentId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: { clusterId: true },
      })
    )
  );
  const agentPageComposition = (rows: Array<{ clusterId: string | null }>) => ({
    clustered: rows.filter((row) => row.clusterId !== null).length,
    unclustered: rows.filter((row) => row.clusterId === null).length,
  });
  const smallAgentPageComposition = agentPageComposition(smallAgentPage);
  const denseAgentPageComposition = agentPageComposition(denseAgentPage);
  for (const [name, composition] of [
    ["small", smallAgentPageComposition],
    ["dense", denseAgentPageComposition],
  ] as const) {
    if (composition.clustered < 1 || composition.unclustered < 1) {
      throw new Error(`WIN-235 ${name} Agent page must contain clustered and unclustered bindings`);
    }
  }
  await database.entity.create({
    data: {
      id: entityId,
      projectId,
      externalId: entityExternalId,
      displayName: `WIN-235 ${key} Entity`,
      connectionStatus: "connected",
      connectionKind: "fixture",
      capabilities: ["tools", "context"],
      lastConnectedAt: FIXTURE_TIMESTAMP,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
      mcpConfig: {
        create: {
          enabled: true,
          identityMode: "bearer",
          identityProviders: [],
          branding: {},
          toolAllowlist: [],
          redirectUriAllowlist: [],
          rateLimitPerMinute: 60,
          injectMcpContext: false,
          createdAt: FIXTURE_TIMESTAMP,
          updatedAt: FIXTURE_TIMESTAMP,
        },
      },
    },
  });
  await database.environmentEntityTool.createMany({
    data: tools.map((tool, index) => ({
      id: deterministicUuid(key, "environment-tool", index),
      environmentId,
      entityId,
      toolId: tool.id,
      enabled: true,
      callbackUrl: `https://fixture.invalid/${key}/tools/${encodeURIComponent(tool.name)}`,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    })),
  });
  await database.thread.create({
    data: {
      id: threadId,
      environmentId,
      agentId: agentIds[0],
      endUserId,
      clusterId,
      title: `Dense 60-turn thread ${key}`,
      status: WorkStatus.ACTIVE,
      sessionContext: { fixture: "WIN-235", scope: key },
      tags: ["win235", "dense"],
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  const turnIds = Array.from({ length: TURNS_PER_THREAD }, (_, index) =>
    deterministicUuid(key, "turn", index)
  );
  await database.turn.createMany({
    data: turnIds.map((id, index) => ({
      id,
      threadId,
      agentVersionId: versionIds[0],
      versionBucket: AgentVersionBucket.CURRENT,
      sequence: index + 1,
      inputText: `Deterministic input ${index + 1}`,
      outputText: `Deterministic output ${index + 1}`,
      status: WorkStatus.SUCCEEDED,
      costCents: "0.001000",
      latencyMs: 20 + index,
      startedAt: FIXTURE_TIMESTAMP,
      completedAt: new Date(FIXTURE_TIMESTAMP.getTime() + 20 + index),
      createdAt: FIXTURE_TIMESTAMP,
    })),
  });
  const stepIds = turnIds.map((_, index) => deterministicUuid(key, "step", index));
  await database.step.createMany({
    data: stepIds.map((id, index) => ({
      id,
      turnId: turnIds[index],
      sequence: 1,
      model: "openai:fixture-model",
      status: WorkStatus.SUCCEEDED,
      inputTokens: 10 + index,
      outputTokens: 5 + index,
      latencyMs: 10 + index,
      startedAt: FIXTURE_TIMESTAMP,
      completedAt: new Date(FIXTURE_TIMESTAMP.getTime() + 10 + index),
      createdAt: FIXTURE_TIMESTAMP,
    })),
  });
  await database.toolCall.createMany({
    data: stepIds.slice(0, 20).map((stepId, index) => ({
      id: deterministicUuid(key, "tool-call", index),
      stepId,
      toolId: tools[index].id,
      sequence: 1,
      toolName: tools[index].name,
      arguments: { index, scope: key },
      result: { ok: true, index },
      status: WorkStatus.SUCCEEDED,
      latencyMs: 5 + index,
      startedAt: FIXTURE_TIMESTAMP,
      completedAt: new Date(FIXTURE_TIMESTAMP.getTime() + 5 + index),
      createdAt: FIXTURE_TIMESTAMP,
    })),
  });
  const memoryIds = Array.from({ length: MEMORIES_PER_SCOPE }, (_, index) =>
    deterministicUuid(key, "memory", index)
  );
  await database.memory.createMany({
    data: memoryIds.map((id, index) => {
      const extractedFromFixtureThread = index < 20;
      const agentIndex =
        index < DENSE_MEMORIES_PER_SCOPE
          ? 0
          : 1 + ((index - DENSE_MEMORIES_PER_SCOPE) % (agentIds.length - 1));
      const clusterVisible =
        extractedFromFixtureThread || (index % 2 === 0 && agentIndex % 2 === 0);
      return {
        id,
        environmentId,
        endUserId,
        agentId: agentIds[agentIndex],
        clusterId: clusterVisible ? clusterId : null,
        kind: index === 0 ? "profile" : ["fact", "preference", "event", "relationship"][index % 4],
        content: `Canonical ${key} memory ${String(index + 1).padStart(3, "0")}`,
        metadata: {
          fixture: "WIN-235",
          ordinal: index + 1,
          ...(index === 0 ? { profileKey: `win235-${key}-canonical-profile` } : {}),
        },
        agentVisible: index % 2 === 0,
        visibility: index % 2 === 0 ? "agent_visible" : "private",
        source: extractedFromFixtureThread ? "extracted" : "imported",
        sourceThreadId: extractedFromFixtureThread ? threadId : null,
        sourceTurnIds: extractedFromFixtureThread ? [turnIds[index]] : [],
        extractorVersion: extractedFromFixtureThread ? "win235-fixture-v1" : null,
        contentHash: createHash("sha256").update(`${key}:memory:${index}`).digest("hex"),
        confidence: 0.9,
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
      };
    }),
  });
  const memoryCountsByAgent = await database.memory.groupBy({
    by: ["agentId"],
    where: { environmentId, endUserId },
    _count: { _all: true },
  });
  const denseMemoryCount =
    memoryCountsByAgent.find((row) => row.agentId === agentIds[0])?._count._all ?? 0;
  if (denseMemoryCount !== DENSE_MEMORIES_PER_SCOPE) {
    throw new Error(
      `WIN-235 dense principal memory mismatch: expected ${DENSE_MEMORIES_PER_SCOPE}, received ${denseMemoryCount}`
    );
  }
  if (
    memoryCountsByAgent.length !== agentIds.length ||
    memoryCountsByAgent.some((row) => row._count._all < 1)
  ) {
    throw new Error(
      "WIN-235 memory fixture must retain persisted data on every representative Agent"
    );
  }
  const graphIds = Array.from({ length: graphEntityCount }, (_, index) =>
    deterministicUuid(key, "memory-entity", index)
  );
  await database.memoryEntity.createMany({
    data: graphIds.map((id, index) => ({
      id,
      environmentId,
      endUserId,
      agentId: agentIds[0],
      clusterId,
      entityKey: `win235:${key}:graph:${String(index + 1).padStart(3, "0")}`,
      entityType: index % 2 === 0 ? "person" : "organization",
      label: `Graph entity ${key}-${index + 1}`,
      aliases: [`${key}-${index + 1}`],
      metadata: { fixture: "WIN-235" },
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    })),
  });
  await database.memoryRelationship.createMany({
    data: graphIds.slice(0, -1).map((fromEntityId, index) => ({
      id: deterministicUuid(key, "memory-relationship", index),
      environmentId,
      endUserId,
      agentId: agentIds[0],
      clusterId,
      fromEntityId,
      toEntityId: graphIds[index + 1],
      relationshipType: "fixture_link",
      weight: 1,
      metadata: { fixture: "WIN-235" },
      sourceMemoryId: memoryIds[index % 20],
      createdAt: FIXTURE_TIMESTAMP,
    })),
  });

  await database.artifact.create({
    data: {
      id: deterministicUuid(key, "artifact"),
      environmentId,
      threadId,
      producedByTurnId: turnIds[0],
      artifactKey: "fixture-report",
      kind: "report",
      title: "WIN-235 fixture report",
      mimeType: "application/json",
      content: JSON.stringify({ fixture: "WIN-235", scope: key }),
      createdBy: operatorId,
      createdAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.agentApproval.create({
    data: {
      id: deterministicUuid(key, "approval"),
      environmentId,
      agentId: agentIds[0],
      threadId,
      turnId: turnIds[0],
      action: "fixture.destructive-action",
      status: ApprovalStatus.PENDING,
      toolName: tools[0].name,
      arguments: { fixture: "WIN-235" },
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.budget.create({
    data: {
      id: deterministicUuid(key, "budget"),
      environmentId,
      agentId: agentIds[0],
      scope: "agent",
      period: "month",
      limitCents: 10000,
      turnsLimit: 1000,
      alertThresholds: [50, 80, 100],
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.safetyEvent.create({
    data: {
      id: deterministicUuid(key, "safety-event"),
      environmentId,
      agentId: agentIds[0],
      threadId,
      turnId: turnIds[0],
      endUserId,
      detector: "fixture",
      action: "allow",
      severity: "low",
      detail: "Representative operational gate fixture",
      metadata: { fixture: "WIN-235" },
      createdAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.toolCallAudit.create({
    data: {
      id: deterministicUuid(key, "tool-call-audit"),
      environmentId,
      toolId: tools[0].id,
      endUserId,
      agentId: agentIds[0],
      threadId,
      toolName: tools[0].name,
      arguments: { fixture: "WIN-235" },
      result: { ok: true },
      status: WorkStatus.SUCCEEDED,
      latencyMs: 12,
      traceId: createHash("sha256").update(`win235:${key}:trace`).digest("hex").slice(0, 32),
      createdAt: FIXTURE_TIMESTAMP,
    },
  });
  await database.job.create({
    data: {
      id: jobId,
      environmentId,
      externalId: `win235-${key}-job`,
      displayName: `WIN-235 ${key} Job`,
      description: "Canonical WIN-235 persisted Job fixture",
      invocationType: "manual",
      allowedAgentIds: [agentIds[0]],
      payloadSchema: { type: "object", additionalProperties: true },
      handler: 'return { fixture: "WIN-235", payload };',
      timeoutSeconds: 300,
      maxRetries: 3,
      status: WorkStatus.ACTIVE,
      createdBy: operatorId,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  });

  return {
    key,
    organizationId,
    organizationSlug: `win235-${key}`,
    projectId,
    projectSlug: `win235-${key}-project`,
    environmentId,
    environmentSlug: "development",
    operatorId,
    userId: operatorId,
    endUserId,
    externalUserId,
    entityId,
    entityExternalId,
    clusterId,
    threadId,
    jobId,
    agentIds,
    publicGuestAgentId: agentIds[0],
    versionIds,
    profileMemoryId: memoryIds[0],
    denseMemoryCount,
    memoryAgentCount: memoryCountsByAgent.length,
    smallAgentPageComposition,
    denseAgentPageComposition,
    graphEntityIds: graphIds,
  };
}

async function actualCounts() {
  const [
    organizations,
    projects,
    environments,
    operators,
    endUsers,
    agents,
    agentVersions,
    agentBindings,
    clusters,
    threads,
    turns,
    steps,
    toolCalls,
    tools,
    environmentEntityTools,
    memories,
    graphEntities,
    graphRelationships,
    artifacts,
    approvals,
    budgets,
    safetyEvents,
    toolCallAudits,
    jobs,
    postmanTemplates,
    mcpTokens,
  ] = await Promise.all([
    database.organization.count(),
    database.project.count(),
    database.environment.count(),
    database.user.count(),
    database.endUser.count(),
    database.agent.count(),
    database.agentVersion.count(),
    database.agentBinding.count(),
    database.agentCluster.count(),
    database.thread.count(),
    database.turn.count(),
    database.step.count(),
    database.toolCall.count(),
    database.tool.count(),
    database.environmentEntityTool.count(),
    database.memory.count(),
    database.memoryEntity.count(),
    database.memoryRelationship.count(),
    database.artifact.count(),
    database.agentApproval.count(),
    database.budget.count(),
    database.safetyEvent.count(),
    database.toolCallAudit.count(),
    database.job.count(),
    database.postmanTemplate.count(),
    database.mcpToken.count(),
  ]);
  return {
    organizations,
    projects,
    environments,
    operators,
    endUsers,
    agents,
    agentVersions,
    agentBindings,
    clusters,
    threads,
    turns,
    steps,
    toolCalls,
    tools,
    environmentEntityTools,
    memories,
    graphEntities,
    graphRelationships,
    artifacts,
    approvals,
    budgets,
    safetyEvents,
    toolCallAudits,
    jobs,
    postmanTemplates,
    mcpTokens,
  };
}

function assertCounts(actual: Record<string, number>) {
  const expected = {
    organizations: 2,
    projects: 2,
    environments: 2,
    operators: 2,
    endUsers: 2,
    agents: 40,
    agentVersions: 40,
    agentBindings: 40,
    clusters: 2,
    threads: 2,
    turns: 120,
    steps: 120,
    toolCalls: 40,
    tools: 200,
    environmentEntityTools: 400,
    memories: 384,
    graphEntities: 141,
    graphRelationships: 139,
    artifacts: 2,
    approvals: 2,
    budgets: 2,
    safetyEvents: 2,
    toolCallAudits: 2,
    jobs: 2,
    postmanTemplates: POSTMAN_TEMPLATES_PER_SCOPE * 2,
    mcpTokens: MCP_TOKENS_PER_SCOPE * 2,
  };
  for (const [name, count] of Object.entries(expected)) {
    if (actual[name] !== count) {
      throw new Error(
        `WIN-235 fixture count mismatch for ${name}: expected ${count}, received ${actual[name]}`
      );
    }
  }
  return expected;
}

async function redisCommand(url: string, command: string[]): Promise<string> {
  const target = new URL(url);
  const payload = `*${command.length}\r\n${command
    .map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`)
    .join("")}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: target.hostname,
      port: Number(target.port || 6379),
    });
    let response = Buffer.alloc(0);
    socket.setTimeout(5_000);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      const lineEnd = response.indexOf("\r\n");
      if (lineEnd === -1) return;
      const header = response.subarray(0, lineEnd).toString("utf8");
      if (header.startsWith("+") || header.startsWith("-") || header.startsWith(":")) socket.end();
      if (header.startsWith("$")) {
        const byteLength = Number(header.slice(1));
        if (byteLength === -1 || response.length >= lineEnd + 2 + byteLength + 2) socket.end();
      }
    });
    socket.on("end", () => {
      const lineEnd = response.indexOf("\r\n");
      const header = lineEnd === -1 ? "" : response.subarray(0, lineEnd).toString("utf8");
      if (header.startsWith("-")) {
        reject(new Error(`Redis rejected fixture command: ${header.slice(1)}`));
        return;
      }
      if (header.startsWith("$")) {
        const byteLength = Number(header.slice(1));
        resolve(
          byteLength === -1
            ? ""
            : response.subarray(lineEnd + 2, lineEnd + 2 + byteLength).toString("utf8")
        );
        return;
      }
      resolve(header.startsWith("+") || header.startsWith(":") ? header.slice(1) : header);
    });
    socket.on("timeout", () => socket.destroy(new Error("Redis fixture command timed out")));
    socket.on("error", reject);
  });
}

function clickHouseHeaders() {
  return {
    Authorization: `Basic ${Buffer.from(
      `${process.env.CLICKHOUSE_USER}:${process.env.CLICKHOUSE_PASSWORD}`,
      "utf8"
    ).toString("base64")}`,
  };
}

async function clickHouseQuery(query: string): Promise<string> {
  const endpoint = new URL(clickhouseUrl!);
  endpoint.searchParams.set("query", query);
  const response = await fetch(endpoint, { headers: clickHouseHeaders() });
  if (!response.ok) {
    throw new Error(`ClickHouse gate preflight failed with HTTP ${response.status}`);
  }
  return (await response.text()).trim();
}

function hmacSha256(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

async function assertMinioBucketEmpty() {
  const endpoint = new URL(minioUrl!);
  endpoint.pathname = `/${process.env.MINIO_BUCKET}`;
  endpoint.search = "list-type=2&max-keys=1";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update("").digest("hex");
  const canonicalHeaders = [
    `host:${endpoint.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
  ].join("\n");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "GET",
    endpoint.pathname,
    "list-type=2&max-keys=1",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const region = process.env.MINIO_REGION!;
  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const dateKey = hmacSha256(`AWS4${process.env.MINIO_SECRET_KEY}`, date);
  const regionKey = hmacSha256(dateKey, region);
  const serviceKey = hmacSha256(regionKey, "s3");
  const signingKey = hmacSha256(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${process.env.MINIO_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  });
  if (!response.ok) throw new Error(`MinIO gate preflight failed with HTTP ${response.status}`);
  const listing = await response.text();
  if (/<Contents>/.test(listing) || !/<KeyCount>0<\/KeyCount>/.test(listing)) {
    throw new Error("WIN-235 MinIO bucket is not empty before canonical seed");
  }
}

async function assertStoresAreIsolatedAndEmpty() {
  const identity = await database.$queryRawUnsafe<
    Array<{
      databaseName: string;
      schemaName: string;
      organizationTable: string | null;
    }>
  >(
    `SELECT current_database() AS "databaseName", current_schema() AS "schemaName", to_regclass('public."Organization"')::text AS "organizationTable"`
  );
  if (
    identity.length !== 1 ||
    identity[0].databaseName !== "platos_control" ||
    identity[0].schemaName !== "public" ||
    identity[0].organizationTable !== '"Organization"'
  ) {
    throw new Error("Postgres does not identify the migrated isolated WIN-235 schema");
  }

  const tables = await database.$queryRawUnsafe<Array<{ tableName: string }>>(
    `SELECT tablename AS "tableName" FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`
  );
  if (tables.length === 0) throw new Error("WIN-235 Postgres schema has no canonical tables");
  for (const { tableName } of tables) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tableName)) {
      throw new Error("WIN-235 Postgres preflight encountered an unsafe table identifier");
    }
    const [{ count }] = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "${tableName}"`
    );
    if (count !== 0n) {
      throw new Error(`WIN-235 requires an empty schema; found rows in ${tableName}`);
    }
  }

  const redisSize = await redisCommand(redisUrl!, ["DBSIZE"]);
  if (redisSize !== "0") throw new Error(`WIN-235 requires empty Redis; DBSIZE was ${redisSize}`);

  const clickhouseCount = await clickHouseQuery(
    "SELECT count() FROM platos_telemetry.metrics_v1 FORMAT TabSeparated"
  );
  if (clickhouseCount !== "0") {
    throw new Error(`WIN-235 requires empty ClickHouse metrics_v1; count was ${clickhouseCount}`);
  }

  await assertMinioBucketEmpty();
}

async function seedClickHouse(
  scopes: Array<{ organizationId: string; projectId: string; environmentId: string }>
) {
  const base = new URL(clickhouseUrl!);
  const headers = clickHouseHeaders();
  base.searchParams.set("query", "INSERT INTO platos_telemetry.metrics_v1 FORMAT JSONEachRow");
  const rows = scopes.map((scope, index) =>
    JSON.stringify({
      organization_id: scope.organizationId,
      project_id: scope.projectId,
      environment_id: scope.environmentId,
      metric_name: "win235.persisted_fixture",
      metric_type: "counter",
      metric_subject: `scope-${index + 1}`,
      bucket_start: "2026-08-24 00:00:00",
      value: 1,
      attributes: {},
    })
  );
  const insert = await fetch(base, { method: "POST", headers, body: `${rows.join("\n")}\n` });
  if (!insert.ok)
    throw new Error(`ClickHouse fixture insert failed: ${insert.status} ${await insert.text()}`);

  const verify = new URL(clickhouseUrl!);
  verify.searchParams.set(
    "query",
    "SELECT count() FROM platos_telemetry.metrics_v1 WHERE metric_name = 'win235.persisted_fixture' FORMAT TabSeparated"
  );
  const response = await fetch(verify, { headers });
  if (!response.ok) throw new Error(`ClickHouse fixture read-back failed: ${response.status}`);
  const count = Number((await response.text()).trim());
  if (count !== 2)
    throw new Error(`ClickHouse fixture read-back expected 2 rows, received ${count}`);
  return count;
}

async function main() {
  try {
    await database.$connect();
    await assertStoresAreIsolatedAndEmpty();

    // Keep Agent startup deterministic and offline. A fresh empty catalogue
    // otherwise causes the production LiteLLM bootstrap before listen().
    await database.model.create({
      data: {
        id: deterministicUuid("model", "fixture"),
        key: "openai/fixture-model",
        provider: "openai",
        name: "fixture-model",
        displayName: "WIN-235 deterministic fixture model",
        contextWindow: 1000,
        maxOutputTokens: 100,
        capabilities: ["text"],
        sourceUpdatedAt: FIXTURE_TIMESTAMP,
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
        prices: {
          create: {
            id: deterministicUuid("model-price", "fixture"),
            effectiveFrom: FIXTURE_TIMESTAMP,
            inputRate: "0",
            outputRate: "0",
            cacheReadRate: "0",
            cacheWriteRate: "0",
            inputSource: ModelRateSource.VERIFIED_PROVIDER,
            outputSource: ModelRateSource.VERIFIED_PROVIDER,
            cacheReadSource: ModelRateSource.VERIFIED_PROVIDER,
            cacheWriteSource: ModelRateSource.VERIFIED_PROVIDER,
            inputObservedAt: FIXTURE_TIMESTAMP,
            outputObservedAt: FIXTURE_TIMESTAMP,
            cacheReadObservedAt: FIXTURE_TIMESTAMP,
            cacheWriteObservedAt: FIXTURE_TIMESTAMP,
            inputSourceRef: "win235:fixture",
            outputSourceRef: "win235:fixture",
            cacheReadSourceRef: "win235:fixture",
            cacheWriteSourceRef: "win235:fixture",
            createdAt: FIXTURE_TIMESTAMP,
          },
        },
      },
    });

    const tools = Array.from({ length: TOOLS }, (_, index) => ({
      id: deterministicUuid("tool", index),
      name: `win235.tool.${String(index + 1).padStart(3, "0")}`,
    }));
    await database.tool.createMany({
      data: tools.map((tool, index) => ({
        id: tool.id,
        name: tool.name,
        description: `Canonical dense Tool ${index + 1}`,
        kind: index % 10 === 0 ? ToolKind.RUNTIME : ToolKind.ENTITY,
        paramSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        category: ["data", "communication", "operations", "memory"][index % 4],
        schemaHash: createHash("sha256").update(tool.name).digest("hex"),
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
      })),
    });

    const scopes = [
      await seedScope("alpha", GRAPH_ENTITIES[0], tools),
      await seedScope("beta", GRAPH_ENTITIES[1], tools),
    ];
    const counts = await actualCounts();
    assertCounts(counts);

    const manifestBody = {
      schemaVersion: 1,
      fixture: "win235-canonical-dense-v1",
      fixtureTimestamp: FIXTURE_TIMESTAMP.toISOString(),
      counts,
      scopes,
      externalStores: {
        redisKey: "win235:fixture:manifest",
        minioBucket: process.env.MINIO_BUCKET ?? "platos-media",
        minioKey: "win235/fixture-manifest.json",
        clickhouseMetric: "win235.persisted_fixture",
      },
    };
    const canonicalJson = `${JSON.stringify(manifestBody, null, 2)}\n`;
    const sha256 = createHash("sha256").update(canonicalJson).digest("hex");
    const manifest = { ...manifestBody, sha256 };
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

    await redisCommand(redisUrl!, ["SET", manifest.externalStores.redisKey, manifestJson]);
    const redisReadBack = await redisCommand(redisUrl!, ["GET", manifest.externalStores.redisKey]);
    if (!redisReadBack.includes(sha256)) throw new Error("Redis fixture manifest did not persist");
    await seedClickHouse(scopes);

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, manifestJson, "utf8");
    process.stdout.write(`WIN-235 fixture seeded: ${sha256}\n`);
    process.stdout.write(`${JSON.stringify(counts)}\n`);
  } finally {
    await database.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
