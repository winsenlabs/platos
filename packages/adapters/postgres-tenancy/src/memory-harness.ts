// What the `memory` suites need on top of the shared container: a fresh tenant
// chain per suite, and the SEVEN peer rows this context's three tables hang off.
//
// THE TENANT CHAIN GOES THROUGH THE PORT. `Organization`, `Project` and
// `Environment` are `tenancy`'s rows and `tenancy`'s canonical store is this
// same directory (ADR M0.3 §15), so a scope is created by calling
// `saveOrganization`, `saveProject` and `saveEnvironment` rather than by writing
// SQL. A fresh chain per suite is what keeps a listing that returns everything
// for one subject from seeing another suite's rows.
//
// THE PEER CHAIN CANNOT, AND `enforce_domain_ancestry` IS WHY IT IS A CHAIN. It
// fires BEFORE INSERT OR UPDATE on all three of this context's tables, and for
// `Memory` it demands, in one conjunction: an `Environment` under a `Project`
// under an `Organization`; an `EndUser` in THAT organization; an `Agent` in THAT
// project; and — when `clusterId` is not null — an `AgentCluster` in that
// environment AND an `AgentBinding` naming that agent AND that cluster. A source
// thread must be a `Thread` in the same environment with the same end user and
// the same agent, and every `sourceTurnIds` element must be a `Turn` in that very
// thread. There is no shorter fixture that stores a single clustered, extracted
// memory.
//
// `Thread` AND `Turn` ARE SEEDED AS SQL BECAUSE THEY MUST BE. They belong to
// `conversations` (ADR M0.3 §1 row 16), which has NO entry in
// `CANONICAL_STORE_ADAPTERS` — so `sole-writer.mjs` refuses a write to either
// from this directory, correctly, and that refusal is the gate doing its job
// rather than an obstacle to route around. They go through the ORM's own CLI
// (`prisma db execute`), which is runtime and therefore out of the scanner's
// scope by construction.
//
// AND SO ARE `Agent`, `AgentVersion`, `AgentBinding`, `AgentCluster`, `EndUser`
// AND `MessageRating`, WHICH THIS DIRECTORY COULD WRITE. `agents`,
// `identity-access` and `governance` are all delegated here, so six of the seven
// could have gone through their own repositories. They do not, deliberately and
// for the reason `governance-harness.ts` gives: the fixture would then have TWO
// mechanisms for one chain — most of it through ports belonging to contexts this
// suite is not testing, the rest as SQL — and a fixture whose failures can come
// from either is a fixture that has to be debugged before a suite can be read.
//
// THE VECTOR IS SEEDED HERE TOO, AND IT IS NOT A SHORTCUT. `MemoryEntity` has no
// port method that can write its `embedding` — see `memory-entities.ts` — so a
// suite that wants to observe `searchEntities` returning anything at all has to
// put the column there some other way. `seedEntityVector` does it with the same
// raw statement the store uses for `Memory`, and the suite that uses it says in
// its own case that this is the store's contract being demonstrated as
// UNREACHABLE through the port rather than exercised through it.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type {
  AgentId,
  ClusterId,
  EntityKey,
  EnvironmentScope,
  Memory,
  MemoryEntity,
  MemoryEntityId,
  MemoryId,
  MemoryRelationship,
  MemoryRelationshipId,
  MemorySubject,
} from "@platos/context-memory/application/ports/index.js";
import {
  asMemoryIdentifier,
  environmentScope,
  memorySubject,
} from "@platos/context-memory/application/ports/index.js";
import type { EnvironmentId, ProjectId, Slug } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import { EMBEDDING_DIMENSIONS } from "./memory-guards.js";
import type { MemoryStores } from "./memory-repository.js";
import type { TenancyHarness } from "./harness.js";
import { AT, startTenancyHarness } from "./harness.js";

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

const STAMP = "'2026-05-01T09:00:00Z'";

/** One seeded environment, and every peer row a memory in it can point at. */
export interface MemoryChain {
  readonly scope: EnvironmentScope;
  readonly subject: MemorySubject;
  readonly endUserId: string;
  /** The clustered agent every default fixture is attributed to. */
  readonly agentId: string;
  /** A SECOND agent in the SAME cluster. Cross-agent sharing is exactly this. */
  readonly peerAgentId: string;
  /** A third agent in NO cluster. It shares scope with nobody but itself. */
  readonly outsideAgentId: string;
  readonly clusterId: string;
  readonly agentVersionId: string;
  /** A thread owned by `agentId` in `clusterId`, for the extracted memories. */
  readonly threadId: string;
  readonly turnId: string;
  readonly secondTurnId: string;
  /** A thread owned by `outsideAgentId` and NO cluster. */
  readonly standaloneThreadId: string;
  readonly standaloneTurnId: string;
  /** A rating on `turnId`, by this end user. */
  readonly ratingId: string;
}

/**
 * A storable `Memory` for one chain, with everything the schema demands.
 *
 * The context's own `memoryFixture()` cannot be used by these suites: it mints
 * `mem-1` for a `@db.Uuid` column, `agent-1` for another and `org-1` for a
 * third. This builder takes the chain's real uuids and defaults every other
 * column to a value the CHECKs admit, so a case states only the field it is
 * about — which is what `fixtures.ts` says a builder is for.
 */
export function memoryDraft(
  chain: MemoryChain,
  memoryId: string,
  at: Date,
  overrides: Partial<Memory> = {},
): Memory {
  return {
    memoryId: asMemoryIdentifier<MemoryId>(memoryId),
    subject: chain.subject,
    ownership: {
      agentId: asMemoryIdentifier<AgentId>(chain.agentId),
      clusterId: asMemoryIdentifier<ClusterId>(chain.clusterId),
    },
    kind: "fact",
    profileKey: null,
    content: "prefers to be called Sam",
    metadata: null,
    visibility: "agent_visible",
    source: "manual",
    contentHash: null,
    provenance: {
      sourceThreadId: null,
      sourceTurnIds: [],
      extractorVersion: null,
      originalSource: null,
      originalSourceThreadId: null,
      originalSourceTurnIds: [],
    },
    confidence: { confidence: null, feedbackBaselineConfidence: null },
    lifecycle: {
      lastAccessedAt: null,
      quarantinedAt: null,
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    },
    ...overrides,
  };
}

export function entityDraft(
  chain: MemoryChain,
  entityId: string,
  at: Date,
  overrides: Partial<MemoryEntity> = {},
): MemoryEntity {
  return {
    entityId: asMemoryIdentifier<MemoryEntityId>(entityId),
    subject: chain.subject,
    ownership: {
      agentId: asMemoryIdentifier<AgentId>(chain.agentId),
      clusterId: asMemoryIdentifier<ClusterId>(chain.clusterId),
    },
    entityKey: asMemoryIdentifier<EntityKey>("acme-corp"),
    entityType: "org",
    label: "Acme Corp",
    aliases: [],
    metadata: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

export function edgeDraft(
  chain: MemoryChain,
  relationshipId: string,
  fromEntityId: string,
  toEntityId: string,
  at: Date,
  overrides: Partial<MemoryRelationship> = {},
): MemoryRelationship {
  return {
    relationshipId: asMemoryIdentifier<MemoryRelationshipId>(relationshipId),
    subject: chain.subject,
    ownership: {
      agentId: asMemoryIdentifier<AgentId>(chain.agentId),
      clusterId: asMemoryIdentifier<ClusterId>(chain.clusterId),
    },
    fromEntityId: asMemoryIdentifier<MemoryEntityId>(fromEntityId),
    toEntityId: asMemoryIdentifier<MemoryEntityId>(toEntityId),
    relationshipType: "works_at",
    weight: null,
    metadata: null,
    sourceMemoryId: null,
    createdAt: at,
    ...overrides,
  };
}

export interface MemoryHarness {
  readonly base: TenancyHarness;
  readonly stores: MemoryStores;
  /** A brand-new organization, project and environment, through the tenancy port. */
  freshScope(): Promise<EnvironmentScope>;
  /** Every peer row a memory, an entity or an edge in `scope` can point at. */
  seedChain(scope: EnvironmentScope): Promise<MemoryChain>;
  /** A whole second tenant with its own chain, for the cross-tenant proofs. */
  foreignChain(): Promise<MemoryChain>;
  /** Rows this package may not write, applied by the ORM's own CLI. */
  applyPeerRows(sql: string): void;
  /** Put a vector on a `MemoryEntity`, which no port method can do. */
  seedEntityVector(entityId: string, vector: readonly number[]): void;
  /** A `vector(1536)` whose first component is 1 and the rest 0, rotated by `axis`. */
  unitVector(axis: number): readonly number[];
  stop(): Promise<void>;
}

export async function startMemoryHarness(): Promise<MemoryHarness> {
  const base = await startTenancyHarness();
  const stores = base.adapter as unknown as MemoryStores;

  function applyPeerRows(sql: string): void {
    execFileSync(prismaBinary, ["db", "execute", "--url", base.databaseUrl, "--stdin"], {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL: base.databaseUrl },
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  function agentSql(agentId: string, projectId: string): string {
    return `INSERT INTO "Agent" ("id", "projectId", "name", "slug", "isActive", "createdAt", "updatedAt")
            VALUES ('${agentId}', '${projectId}', 'remembering agent', 'agent-${agentId.slice(-12)}', true, ${STAMP}, ${STAMP});`;
  }

  function versionSql(versionId: string, agentId: string): string {
    // The five JSON columns are spelled out because each carries its own
    // `_json_root` CHECK — three arrays, two objects — so a version seeded with
    // the wrong root is refused by the database rather than by the client.
    return `INSERT INTO "AgentVersion"
              ("id", "agentId", "versionNumber", "model", "maxSteps", "contextLimit",
               "toolDefaultPolicy", "promptBlocks", "dynamicBlocks", "toolsBlockConfig",
               "modelRoutes", "memoryConfig", "createdBy", "createdAt")
            VALUES ('${versionId}', '${agentId}', 1, 'anthropic:test-memory', 10, 128000,
                    'NONE', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
                    'fixture', ${STAMP});`;
  }

  function bindingSql(
    bindingId: string,
    environmentId: string,
    agentId: string,
    versionId: string,
    clusterId: string | null,
  ): string {
    const cluster = clusterId === null ? "NULL" : `'${clusterId}'`;
    return `INSERT INTO "AgentBinding"
              ("id", "environmentId", "agentId", "activeAgentVersionId", "clusterId",
               "canaryPercent", "createdAt", "updatedAt")
            VALUES ('${bindingId}', '${environmentId}', '${agentId}', '${versionId}', ${cluster},
                    0, ${STAMP}, ${STAMP});`;
  }

  function threadSql(
    threadId: string,
    environmentId: string,
    agentId: string,
    endUserId: string,
    clusterId: string | null,
  ): string {
    const cluster = clusterId === null ? "NULL" : `'${clusterId}'`;
    return `INSERT INTO "Thread"
              ("id", "environmentId", "agentId", "endUserId", "clusterId", "status",
               "createdAt", "updatedAt")
            VALUES ('${threadId}', '${environmentId}', '${agentId}', '${endUserId}', ${cluster},
                    'ACTIVE', ${STAMP}, ${STAMP});`;
  }

  function turnSql(turnId: string, threadId: string, versionId: string, sequence: number): string {
    // `sequence` starts at 1 because `Turn_usage_check` demands `"sequence" > 0`,
    // and two turns in one thread differ in it because
    // `@@unique([threadId, sequence])` would otherwise refuse the second.
    return `INSERT INTO "Turn"
              ("id", "threadId", "agentVersionId", "versionBucket", "sequence",
               "inputText", "outputText", "status", "createdAt")
            VALUES ('${turnId}', '${threadId}', '${versionId}', 'CURRENT', ${String(sequence)},
                    'call me Sam', 'noted', 'SUCCEEDED', ${STAMP});`;
  }

  const harness: MemoryHarness = {
    base,
    stores,
    applyPeerRows,

    unitVector(axis: number): readonly number[] {
      return Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, index) =>
        index === axis % EMBEDDING_DIMENSIONS ? 1 : 0,
      );
    },

    seedEntityVector(entityId: string, vector: readonly number[]): void {
      applyPeerRows(
        `UPDATE "MemoryEntity" SET "embedding" = '[${vector.join(",")}]'::vector WHERE "id" = '${entityId}';`,
      );
    },

    async freshScope(): Promise<EnvironmentScope> {
      // The WHOLE fresh identifier, not a slice: `Organization.slug` is UNIQUE
      // installation-wide and `freshId` varies only in its LAST group, so a
      // slice of the middle is the same string on every call.
      const organizationId = await base.seedOrganization(`mem-${base.freshId("0021")}`);
      const projectId = await base.seedProject(organizationId, `proj-${base.freshId("0022")}`);
      const environmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("0023"));
      await base.adapter.unitOfWork.run((transaction) =>
        base.adapter.saveEnvironment(
          {
            id: environmentId,
            projectId: projectId as ProjectId,
            slug: asTenancyIdentifier<Slug>("prod"),
            name: "prod",
            archivedAt: null,
            accessKeyRevocationVersion: 0,
            memoryFeedbackBackfillCursor: null,
            memoryFeedbackBackfillCompletedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        ),
      );
      return environmentScope(
        asMemoryIdentifier(organizationId),
        asMemoryIdentifier(projectId),
        asMemoryIdentifier(environmentId),
      );
    },

    async seedChain(scope: EnvironmentScope): Promise<MemoryChain> {
      const agentId = base.freshId("0024");
      const peerAgentId = base.freshId("0025");
      const outsideAgentId = base.freshId("0026");
      const agentVersionId = base.freshId("0027");
      const peerVersionId = base.freshId("0028");
      const outsideVersionId = base.freshId("0029");
      const clusterId = base.freshId("002a");
      const endUserId = base.freshId("002b");
      const threadId = base.freshId("002c");
      const turnId = base.freshId("002d");
      const secondTurnId = base.freshId("002e");
      const standaloneThreadId = base.freshId("002f");
      const standaloneTurnId = base.freshId("0030");
      const ratingId = base.freshId("0031");

      applyPeerRows(
        [
          agentSql(agentId, scope.projectId),
          agentSql(peerAgentId, scope.projectId),
          agentSql(outsideAgentId, scope.projectId),
          versionSql(agentVersionId, agentId),
          versionSql(peerVersionId, peerAgentId),
          versionSql(outsideVersionId, outsideAgentId),
          `INSERT INTO "AgentCluster" ("id", "environmentId", "name", "slug", "createdAt", "updatedAt")
           VALUES ('${clusterId}', '${scope.environmentId}', 'support', 'support-${clusterId.slice(-12)}', ${STAMP}, ${STAMP});`,
          bindingSql(base.freshId("0032"), scope.environmentId, agentId, agentVersionId, clusterId),
          bindingSql(base.freshId("0033"), scope.environmentId, peerAgentId, peerVersionId, clusterId),
          bindingSql(base.freshId("0034"), scope.environmentId, outsideAgentId, outsideVersionId, null),
          `INSERT INTO "EndUser" ("id", "organizationId", "displayName", "createdAt", "updatedAt")
           VALUES ('${endUserId}', '${scope.organizationId}', 'subject', ${STAMP}, ${STAMP});`,
          threadSql(threadId, scope.environmentId, agentId, endUserId, clusterId),
          turnSql(turnId, threadId, agentVersionId, 1),
          turnSql(secondTurnId, threadId, agentVersionId, 2),
          threadSql(standaloneThreadId, scope.environmentId, outsideAgentId, endUserId, null),
          turnSql(standaloneTurnId, standaloneThreadId, outsideVersionId, 1),
          `INSERT INTO "MessageRating"
             ("id", "environmentId", "turnId", "agentId", "agentVersionId", "endUserId",
              "rating", "revision", "createdAt", "updatedAt")
           VALUES ('${ratingId}', '${scope.environmentId}', '${turnId}', '${agentId}',
                   '${agentVersionId}', '${endUserId}', 1, 1, ${STAMP}, ${STAMP});`,
        ].join("\n"),
      );

      return {
        scope,
        subject: memorySubject(scope, asMemoryIdentifier(endUserId)),
        endUserId,
        agentId,
        peerAgentId,
        outsideAgentId,
        clusterId,
        agentVersionId,
        threadId,
        turnId,
        secondTurnId,
        standaloneThreadId,
        standaloneTurnId,
        ratingId,
      };
    },

    async foreignChain(): Promise<MemoryChain> {
      return harness.seedChain(await harness.freshScope());
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
  return harness;
}
