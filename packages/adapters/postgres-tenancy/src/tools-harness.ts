// The real-PostgreSQL fixture the four `tools` integration suites share.
//
// It builds on `startIdentityHarness`, which builds on `startTenancyHarness`,
// for the reason every tranche before it did: the ten `tools` rows live in the
// SAME database behind the SAME client as every other canonical row (ADR M0.3
// §15), and a suite that started a container of its own would be measuring an
// arrangement that does not ship.
//
// WHAT IT SEEDS AND WHY MOST OF IT IS SQL. `ToolsRepository` can create a `Tool`
// and an exposure and nothing else. Everything those two hang off belongs to
// another context and has no writer in this tree yet:
//
//   `Entity`      tenancy's, and reachable through the SAME adapter, so it is
//                 written through `saveEntity` rather than in SQL.
//   `Agent`, `AgentVersion`, `AgentBinding`   `agents`. Raw SQL.
//   `Credential`  `secrets`. Raw SQL, and only ever as a NAME — no material.
//   `Thread`, `Turn`, `Step`                  `conversations`. Raw SQL, and the
//                 three of them are what a single `ToolCall` needs before it can
//                 exist at all.
//
// Seeding those in SQL is honest about the fact that this suite stands in for
// mints that V1 does not have yet, rather than pretending the port could have
// made them.
//
// THE ANCESTRY TRIGGERS DECIDE THE SEEDING ORDER AND THEY ARE NOT IN
// `schema.prisma`. `Thread_ancestry` refuses a thread whose agent is not in the
// environment's project or whose end user is not in that project's organization;
// `EnvironmentEntityTool_ancestry` and `EntityToolPolicy_ancestry` refuse an
// entity that is not in the environment's project; `EntityMcpClient_ancestry`
// refuses a credential whose environment's project is not the entity's. Every
// one of them FIRES ON UPDATE as well as INSERT. They are the reason this
// harness seeds a whole coherent tenant rather than the two rows a case needs.
//
// A SECOND CLIENT, because durability is not "the writer can see its row".
//
// IT FAILS WHEN DOCKER IS ABSENT rather than skipping, inherited from below.

import type {
  ActorId,
  AgentId,
  CredentialId,
  CredentialName,
  EndUserId,
  EntityId,
  EnvironmentScope,
  ExternalEntityId,
  SchemaHash,
  ThreadId,
  ToolName,
  ToolsRepository,
} from "@platos/context-tools/application/ports/index.js";
import { asToolsIdentifier } from "@platos/context-tools/application/ports/index.js";

import type { PostgresTenancyAdapter } from "./adapter.js";
import type { TenancyDatabaseClient } from "./client.js";
import { createTenancyDatabaseClient } from "./client.js";
import { entityIdOf, projId } from "./harness.js";
import { startIdentityHarness, type IdentityHarness, type SeededTenant } from "./identity-harness.js";

const AT = new Date("2026-05-01T09:00:00.000Z");

/** One whole tenant, with everything the ten rows hang off already in place. */
export interface SeededToolsTenant extends SeededTenant {
  readonly scope: EnvironmentScope;
  /** A `wire` entity with a persistent callback. */
  readonly wireEntityId: string;
  readonly wireExternalId: string;
  /** An `mcp` entity, with no client row until a case writes one. */
  readonly mcpEntityId: string;
  readonly mcpExternalId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly endUserId: string;
  readonly threadId: string;
  readonly stepId: string;
  readonly credentialId: string;
  readonly credentialName: string;
}

export interface ToolsHarness {
  readonly adapter: PostgresTenancyAdapter;
  readonly repository: ToolsRepository;
  readonly client: TenancyDatabaseClient;
  /** A client over the same database that this adapter's pool never touched. */
  readonly onlooker: TenancyDatabaseClient;
  readonly first: SeededToolsTenant;
  readonly second: SeededToolsTenant;
  statements(): readonly string[];
  resetStatements(): void;
  freshId(kind: string): string;
  seedToolsTenant(slug: string): Promise<SeededToolsTenant>;
  /** A `Turn` and a `Step` under a tenant's thread. Returns the step id. */
  seedStep(tenant: SeededToolsTenant, sequence: number): Promise<string>;
  /** `EnvironmentEntityTool` rows, read through the SECOND client. */
  durableExposures(environmentId: string): Promise<readonly { toolId: string; enabled: boolean }[]>;
  /** `ToolHealth` rows for one (environment, tool), read through the second client. */
  durableHealth(environmentId: string, toolId: string): Promise<readonly { id: string }[]>;
  /** An audit row shaped the way a pre-envelope producer wrote one. */
  seedLegacyAudit(input: {
    readonly environmentId: string;
    readonly toolName: string;
    readonly argumentsValue: Readonly<Record<string, unknown>>;
    readonly createdAt: Date;
  }): Promise<string>;
  stop(): Promise<void>;
}

export async function startToolsHarness(): Promise<ToolsHarness> {
  const base: IdentityHarness = await startIdentityHarness();
  const onlooker = createTenancyDatabaseClient({ databaseUrl: base.databaseUrl });
  const { adapter, client } = base;

  async function seedEntity(
    projectId: string,
    externalId: string,
    connectionKind: "wire" | "mcp",
  ): Promise<string> {
    const id = base.freshId("0201");
    await adapter.unitOfWork.run((transaction) =>
      adapter.saveEntity(
        {
          id: entityIdOf(id),
          projectId: projId(projectId),
          externalId,
          displayName: externalId,
          connectionStatus: "connected",
          connectionKind,
          mcpUrls: [],
          allowedOrigins: [],
          capabilities: [],
          lastConnectedAt: null,
          createdAt: AT,
          updatedAt: AT,
        },
        transaction,
      ),
    );
    return id;
  }

  async function seedToolsTenant(slug: string): Promise<SeededToolsTenant> {
    const tenant = await base.seedTenant(slug);
    const wireEntityId = await seedEntity(tenant.projectId, `${slug}-wire`, "wire");
    const mcpEntityId = await seedEntity(tenant.projectId, `${slug}-mcp`, "mcp");

    const agentId = base.freshId("0202");
    const agentVersionId = base.freshId("0203");
    await client.$executeRawUnsafe(
      `INSERT INTO "Agent" ("id","projectId","name","slug","isActive","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,$3,$3,TRUE,$4::timestamp,$4::timestamp)`,
      agentId,
      tenant.projectId,
      `${slug}-agent`,
      AT,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "AgentVersion" ("id","agentId","versionNumber","model","toolDefaultPolicy","createdBy","createdAt") VALUES ($1::uuid,$2::uuid,1,'test-model','NONE','harness',$3::timestamp)`,
      agentVersionId,
      agentId,
      AT,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "AgentBinding" ("id","environmentId","agentId","activeAgentVersionId","canaryPercent","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,0,$5::timestamp,$5::timestamp)`,
      base.freshId("0204"),
      tenant.environmentId,
      agentId,
      agentVersionId,
      AT,
    );

    const endUserId = await base.seedEndUser({
      organizationId: tenant.organizationId,
      displayName: `${slug}-user`,
      disabledAt: null,
      createdAt: AT,
      identities: [],
    });
    const threadId = base.freshId("0205");
    await client.$executeRawUnsafe(
      `INSERT INTO "Thread" ("id","environmentId","agentId","endUserId","status","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ACTIVE',$5::timestamp,$5::timestamp)`,
      threadId,
      tenant.environmentId,
      agentId,
      endUserId,
      AT,
    );

    const credentialId = base.freshId("0206");
    const credentialName = `${slug}-key`;
    await client.$executeRawUnsafe(
      `INSERT INTO "Credential" ("id","environmentId","kind","name","permissions","allowedOrigins","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,'API_KEY'::"CredentialKind",$3,ARRAY[]::text[],ARRAY[]::text[],$4::timestamp,$4::timestamp)`,
      credentialId,
      tenant.environmentId,
      credentialName,
      AT,
    );

    const tenantRecord: SeededToolsTenant = {
      ...tenant,
      scope: {
        level: "environment",
        organizationId: asToolsIdentifier(tenant.organizationId),
        projectId: asToolsIdentifier(tenant.projectId),
        environmentId: asToolsIdentifier(tenant.environmentId),
      },
      wireEntityId,
      wireExternalId: `${slug}-wire`,
      mcpEntityId,
      mcpExternalId: `${slug}-mcp`,
      agentId,
      agentVersionId,
      endUserId,
      threadId,
      stepId: "",
      credentialId,
      credentialName,
    };
    const stepId = await seedStep(tenantRecord, 1);
    return { ...tenantRecord, stepId };
  }

  async function seedStep(tenant: SeededToolsTenant, sequence: number): Promise<string> {
    const turnId = base.freshId("0207");
    const stepId = base.freshId("0208");
    await client.$executeRawUnsafe(
      `INSERT INTO "Turn" ("id","threadId","agentVersionId","versionBucket","sequence","status","createdAt") VALUES ($1::uuid,$2::uuid,$3::uuid,'ACTIVE'::"AgentVersionBucket",$4,'ACTIVE',$5::timestamp)`,
      turnId,
      tenant.threadId,
      tenant.agentVersionId,
      sequence,
      AT,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Step" ("id","turnId","sequence","model","status","retryCount","createdAt") VALUES ($1::uuid,$2::uuid,1,'test-model','ACTIVE',0,$3::timestamp)`,
      stepId,
      turnId,
      AT,
    );
    return stepId;
  }

  const first = await seedToolsTenant("tools-first");
  const second = await seedToolsTenant("tools-second");

  return {
    adapter,
    repository: adapter,
    client,
    onlooker,
    first,
    second,
    statements: base.statements,
    resetStatements: base.resetStatements,
    freshId: base.freshId,
    seedToolsTenant,
    seedStep,

    async durableExposures(environmentId) {
      const rows = await onlooker.environmentEntityTool.findMany({
        where: { environmentId },
        select: { toolId: true, enabled: true },
        orderBy: { toolId: "asc" },
      });
      return rows;
    },

    async durableHealth(environmentId, toolId) {
      return onlooker.toolHealth.findMany({
        where: { environmentId, toolId },
        select: { id: true },
        orderBy: { id: "asc" },
      });
    },

    async seedLegacyAudit(input) {
      // RAW, THROUGH THE ONLOOKER, and the point is the SHAPE: a pre-envelope
      // row carries its arguments at the root of the column with no
      // `__platosAudit` key, and nothing this package can call writes one any
      // more. Writing it through `appendAudit` would produce the envelope it is
      // standing in for.
      const id = base.freshId("0209");
      await onlooker.$executeRaw`
        INSERT INTO "public"."ToolCallAudit"
          ("id", "environmentId", "toolName", "arguments", "status", "latencyMs", "createdAt")
        VALUES (
          ${id}::uuid,
          ${input.environmentId}::uuid,
          ${input.toolName},
          ${JSON.stringify(input.argumentsValue)}::jsonb,
          'SUCCEEDED'::"WorkStatus",
          12,
          ${input.createdAt}
        )`;
      return id;
    },

    async stop() {
      await onlooker.$disconnect();
      await base.stop();
    },
  };
}

// Typed identifier constructors. A bare `asToolsIdentifier("x")` infers the
// generic brand and is rejected by every parameter that wants a specific one, so
// the suites name each brand ONCE, here, rather than at each of sixty call
// sites. `harness.ts` does the same for tenancy's, and for the same reason.
export const toolsEntityId = (value: string): EntityId => asToolsIdentifier<EntityId>(value);
export const toolsAgentId = (value: string): AgentId => asToolsIdentifier<AgentId>(value);
export const toolsThreadId = (value: string): ThreadId => asToolsIdentifier<ThreadId>(value);
export const toolsEndUserId = (value: string): EndUserId => asToolsIdentifier<EndUserId>(value);
export const toolsActorId = (value: string): ActorId => asToolsIdentifier<ActorId>(value);
export const toolsExternalId = (value: string): ExternalEntityId =>
  asToolsIdentifier<ExternalEntityId>(value);
export const toolsCredentialId = (value: string): CredentialId =>
  asToolsIdentifier<CredentialId>(value);
export const toolsCredentialName = (value: string): CredentialName =>
  asToolsIdentifier<CredentialName>(value);
export const toolsName = (value: string): ToolName => asToolsIdentifier<ToolName>(value);
export const toolsSchemaHash = (value: string): SchemaHash =>
  asToolsIdentifier<SchemaHash>(value);
