// The real-PostgreSQL fixture the four `tools` integration suites share.
//
// It builds on `startIdentityHarness`, which builds on `startTenancyHarness`,
// for the reason every tranche before it did: the ten `tools` rows live in the
// SAME database behind the SAME client as every other canonical row (ADR M0.3
// §15), and a suite that started a container of its own would be measuring an
// arrangement that does not ship.
//
// IT CLAIMS TENANTS RATHER THAN MINTING THEM, AND THE SOLE-WRITER GATE IS WHY.
// A coherent `tools` fixture needs `Agent`, `AgentVersion`, `AgentBinding`,
// `Thread`, `Turn`, `Step` and `Credential`, which belong to `agents`,
// `conversations` and `secrets`. An earlier draft of this file wrote all seven in
// raw SQL from here and `scripts/arch/sole-writer.mjs` refused every one:
//
//   FAIL src/tools-harness.ts:148 — Agent.$executeRawUnsafe: insert into() may
//   be called only from packages/contexts/agents; agents is its sole writer
//
// The refusal is right, so the rows moved to `fixtures/tools-rows.sql`, which
// `prisma db execute` applies with no code path in any package — the same
// mechanism, and the same argument, as `fixtures/identity-access-rows.sql`. That
// leaves this file with no write it is not the delegate for, which is the state
// the gate exists to produce.
//
// `seedToolsTenant` THEREFORE ALLOCATES, and its `label` is a diagnostic rather
// than a key. Sixteen tenants are pre-seeded and a suite claims them in order;
// running out is an explicit failure rather than a silent reuse, because two
// cases sharing a tenant would share its
// `@@unique([environmentId, entityId, toolId])` and fail each other in ways that
// look like defects in the store.
//
// A SECOND CLIENT, because durability is not "the writer can see its row".
//
// IT FAILS WHEN DOCKER IS ABSENT rather than skipping, inherited from below.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

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
import { startIdentityHarness, type IdentityHarness } from "./identity-harness.js";

/** How many complete tenants `fixtures/tools-rows.sql` seeds. */
export const SEEDED_TENANTS = 16;

/** How many `Step` rows each of them carries. */
export const STEPS_PER_TENANT = 4;

/** One whole tenant, with everything the ten rows hang off already in place. */
export interface SeededToolsTenant {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly scope: EnvironmentScope;
  /** A `wire` entity, reachable at whatever callback a case registers. */
  readonly wireEntityId: string;
  readonly wireExternalId: string;
  /** An `mcp` entity, with no client row until a case writes one. */
  readonly mcpEntityId: string;
  readonly mcpExternalId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly endUserId: string;
  readonly threadId: string;
  /** The first of this tenant's four steps. `seedStep` hands out the rest. */
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
  /** Claim the next unused pre-seeded tenant. The label is for diagnostics. */
  seedToolsTenant(label: string): Promise<SeededToolsTenant>;
  /** Claim the next unused pre-seeded `Step` of a tenant. */
  seedStep(tenant: SeededToolsTenant, ordinal: number): Promise<string>;
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

/** The fixture's derived identifier scheme, transcribed. See the .sql file. */
function fixtureId(kind: string, index: number): string {
  return `d0d0d0d0-0000-4000-8000-${kind}${index.toString(16).padStart(8, "0")}`;
}

function tenantAt(index: number): SeededToolsTenant {
  const label = `tools-${String(index).padStart(2, "0")}`;
  const organizationId = fixtureId("0001", index);
  const projectId = fixtureId("0002", index);
  const environmentId = fixtureId("0003", index);
  return {
    organizationId,
    projectId,
    environmentId,
    scope: {
      level: "environment",
      organizationId: asToolsIdentifier(organizationId),
      projectId: asToolsIdentifier(projectId),
      environmentId: asToolsIdentifier(environmentId),
    },
    wireEntityId: fixtureId("0004", index),
    wireExternalId: `${label}-wire`,
    mcpEntityId: fixtureId("0005", index),
    mcpExternalId: `${label}-mcp`,
    agentId: fixtureId("0006", index),
    agentVersionId: fixtureId("0007", index),
    endUserId: fixtureId("0009", index),
    threadId: fixtureId("000a", index),
    stepId: fixtureId("0200", index * 16),
    credentialId: fixtureId("000b", index),
    credentialName: `${label}-key`,
  };
}

/** The tenant index encoded in a claimed tenant's environment id. */
function indexOf(tenant: SeededToolsTenant): number {
  return Number.parseInt(tenant.environmentId.slice(-8), 16);
}

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

export async function startToolsHarness(): Promise<ToolsHarness> {
  const base: IdentityHarness = await startIdentityHarness();
  execFileSync(
    prismaBinary,
    [
      "db",
      "execute",
      "--url",
      base.databaseUrl,
      "--file",
      resolve(packageRoot, "fixtures/tools-rows.sql"),
    ],
    { cwd: databasePackage, env: { ...process.env, DATABASE_URL: base.databaseUrl }, stdio: "pipe" },
  );

  const onlooker = createTenancyDatabaseClient({ databaseUrl: base.databaseUrl });
  const { adapter } = base;
  let claimed = 0;
  const stepsTaken = new Map<string, number>();

  function claim(label: string): SeededToolsTenant {
    if (claimed >= SEEDED_TENANTS) {
      throw new Error(
        `fixtures/tools-rows.sql seeds ${String(SEEDED_TENANTS)} tenants and ${label} asked for one more; raise the loop bound in the fixture rather than reusing a tenant`,
      );
    }
    const tenant = tenantAt(claimed);
    claimed += 1;
    return tenant;
  }

  const first = claim("first");
  const second = claim("second");

  return {
    adapter,
    repository: adapter,
    client: base.client,
    onlooker,
    first,
    second,
    statements: base.statements,
    resetStatements: base.resetStatements,
    freshId: base.freshId,

    async seedToolsTenant(label) {
      return claim(label);
    },

    async seedStep(tenant, ordinal) {
      // `ordinal` is a caller's label, not an index: two cases in one file that
      // both asked for "another step" must not be handed the same row, and
      // `@@unique([stepId, sequence])` would make that look like a defect in
      // `saveCall` rather than in the fixture.
      const taken = stepsTaken.get(tenant.environmentId) ?? 0;
      if (taken >= STEPS_PER_TENANT) {
        throw new Error(
          `tenant ${tenant.environmentId} has ${String(STEPS_PER_TENANT)} seeded steps and ordinal ${String(ordinal)} asked for one more`,
        );
      }
      stepsTaken.set(tenant.environmentId, taken + 1);
      return fixtureId("0200", indexOf(tenant) * 16 + taken);
    },

    async durableExposures(environmentId) {
      return onlooker.environmentEntityTool.findMany({
        where: { environmentId },
        select: { toolId: true, enabled: true },
        orderBy: { toolId: "asc" },
      });
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
      // standing in for. `ToolCallAudit` is a row this directory IS the delegate
      // writer of, so unlike the seven in the fixture it may be written here.
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
