// What the `governance` suites need on top of the shared container: a fresh
// tenant chain per suite, and the FIVE peer rows this context's own tables hang
// off.
//
// THE TENANT CHAIN GOES THROUGH THE PORT. `Organization`, `Project` and
// `Environment` are `tenancy`'s rows and `tenancy`'s canonical store is this
// same directory (ADR M0.3 §15), so a scope is created by calling
// `saveOrganization`, `saveProject` and `saveEnvironment` rather than by writing
// SQL. A fresh chain per suite is what keeps a listing that returns everything
// in an environment from seeing another suite's rows.
//
// THE PEER CHAIN CANNOT, AND `Thread` AND `Turn` ARE THE REASON. Every one of
// `governance`'s five tables points at something another context owns:
//
//   `SafetyEvent`  -> Agent, Thread, Turn, EndUser        (all nullable)
//   `MessageRating`-> Turn, Agent, AgentVersion, EndUser  (three required)
//   `EvalCriterion`-> Agent                               (nullable)
//   `AgentEval`    -> Agent, AgentVersion, Thread, Turn   (two required)
//   `GoldenSet`    -> Agent                               (required)
//
// `Thread` and `Turn` belong to `conversations` (ADR M0.3 §1 row 16), which has
// NO entry in `CANONICAL_STORE_ADAPTERS` — so `sole-writer.mjs` refuses a write
// to either from this directory, correctly, and that refusal is the gate doing
// its job rather than an obstacle to route around. They are seeded through the
// ORM's own CLI (`prisma db execute`) instead, which is runtime and therefore
// out of the scanner's scope by construction.
//
// AND SO ARE `Agent`, `AgentVersion` AND `EndUser`, WHICH THIS DIRECTORY COULD
// WRITE. `agents` and `identity-access` are both delegated here, so those three
// could have gone through their own repositories. They do not, deliberately: the
// fixture would then have TWO mechanisms for one chain — half of it through
// ports belonging to contexts this suite is not testing, half through SQL — and
// a fixture whose failures can come from either is a fixture that has to be
// debugged before a suite can be read.
//
// `enforce_domain_ancestry` IS WHY THE CHAIN IS A CHAIN. It fires BEFORE INSERT
// OR UPDATE on all five of this context's tables, and for `MessageRating` it
// demands that the turn's THREAD belong to this environment AND to this very end
// user. So a rating cannot be seeded against a turn in somebody else's
// conversation, which is exactly the cross-tenant case one of the constraint
// proofs needs — and the ONLY way to build it is to seed a second, foreign
// chain, which `foreignChain()` below does.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type { EnvironmentScope } from "@platos/context-governance/application/ports/index.js";
import { asIdentifier, environmentScope } from "@platos/context-governance/application/ports/index.js";
import type { EnvironmentId, ProjectId, Slug } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { GovernanceStores } from "./governance-repository.js";
import type { TenancyHarness } from "./harness.js";
import { AT, startTenancyHarness } from "./harness.js";

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

/** One seeded conversation, and everything it hangs off. */
export interface PeerChain {
  readonly scope: EnvironmentScope;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly secondAgentVersionId: string;
  readonly endUserId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly secondTurnId: string;
}

export interface GovernanceHarness {
  readonly base: TenancyHarness;
  readonly stores: GovernanceStores;
  /** A brand-new organization, project and environment, through the tenancy port. */
  freshScope(): Promise<EnvironmentScope>;
  /** An agent, two versions, an end user, a thread and two turns inside `scope`. */
  seedChain(scope: EnvironmentScope): Promise<PeerChain>;
  /** A whole second tenant with its own chain, for the cross-tenant proofs. */
  foreignChain(): Promise<PeerChain>;
  /** An `Agent` alone, for the rows whose only peer is one. */
  seedAgent(scope: EnvironmentScope): Promise<string>;
  /** Rows this package may not write, applied by the ORM's own CLI. */
  applyPeerRows(sql: string): void;
  stop(): Promise<void>;
}

const STAMP = "'2026-05-01T09:00:00Z'";

export async function startGovernanceHarness(): Promise<GovernanceHarness> {
  const base = await startTenancyHarness();
  const stores = base.adapter as unknown as GovernanceStores;

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
            VALUES ('${agentId}', '${projectId}', 'judged agent', 'judged-${agentId.slice(-12)}', true, ${STAMP}, ${STAMP});`;
  }

  function versionSql(versionId: string, agentId: string, versionNumber: number): string {
    // The five JSON columns are spelled out because each carries its own
    // `_json_root` CHECK — three arrays, two objects — and `toolsBlockConfig`
    // carries a SECOND check forbidding an `enabledTools` key. A version seeded
    // with the wrong root is refused by the database, not by Prisma.
    return `INSERT INTO "AgentVersion"
              ("id", "agentId", "versionNumber", "model", "maxSteps", "contextLimit",
               "toolDefaultPolicy", "promptBlocks", "dynamicBlocks", "toolsBlockConfig",
               "modelRoutes", "memoryConfig", "createdBy", "createdAt")
            VALUES ('${versionId}', '${agentId}', ${versionNumber}, 'anthropic:test-judge', 10, 128000,
                    'NONE', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
                    'fixture', ${STAMP});`;
  }

  const harness: GovernanceHarness = {
    base,
    stores,
    applyPeerRows,

    async freshScope(): Promise<EnvironmentScope> {
      // The WHOLE fresh identifier, not a slice: `Organization.slug` is UNIQUE
      // installation-wide and `freshId` varies only in its LAST group, so a
      // slice of the middle is the same string on every call.
      const organizationId = await base.seedOrganization(`gov-${base.freshId("0011")}`);
      const projectId = await base.seedProject(organizationId, `proj-${base.freshId("0012")}`);
      const environmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("0013"));
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
        asIdentifier(organizationId),
        asIdentifier(projectId),
        asIdentifier(environmentId),
      );
    },

    async seedAgent(scope: EnvironmentScope): Promise<string> {
      const agentId = base.freshId("0014");
      applyPeerRows(agentSql(agentId, scope.projectId));
      return agentId;
    },

    async seedChain(scope: EnvironmentScope): Promise<PeerChain> {
      const agentId = base.freshId("0015");
      const agentVersionId = base.freshId("0016");
      const secondAgentVersionId = base.freshId("0017");
      const endUserId = base.freshId("0018");
      const threadId = base.freshId("0019");
      const turnId = base.freshId("001a");
      const secondTurnId = base.freshId("001b");
      applyPeerRows(
        [
          agentSql(agentId, scope.projectId),
          versionSql(agentVersionId, agentId, 1),
          versionSql(secondAgentVersionId, agentId, 2),
          `INSERT INTO "EndUser" ("id", "organizationId", "displayName", "createdAt", "updatedAt")
           VALUES ('${endUserId}', '${scope.organizationId}', 'rater', ${STAMP}, ${STAMP});`,
          `INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "status", "createdAt", "updatedAt")
           VALUES ('${threadId}', '${scope.environmentId}', '${agentId}', '${endUserId}', 'ACTIVE', ${STAMP}, ${STAMP});`,
          // `sequence` starts at 1 because `Turn_usage_check` demands
          // `"sequence" > 0`, and the two turns differ in it because
          // `@@unique([threadId, sequence])` would otherwise refuse the second.
          `INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence",
                               "inputText", "outputText", "status", "createdAt")
           VALUES ('${turnId}', '${threadId}', '${agentVersionId}', 'CURRENT', 1,
                   'what is the refund window', 'thirty days', 'SUCCEEDED', ${STAMP});`,
          `INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence",
                               "inputText", "outputText", "status", "createdAt")
           VALUES ('${secondTurnId}', '${threadId}', '${secondAgentVersionId}', 'CANARY', 2,
                   'and for opened items', 'fourteen days', 'SUCCEEDED', ${STAMP});`,
        ].join("\n"),
      );
      return {
        scope,
        agentId,
        agentVersionId,
        secondAgentVersionId,
        endUserId,
        threadId,
        turnId,
        secondTurnId,
      };
    },

    async foreignChain(): Promise<PeerChain> {
      return harness.seedChain(await harness.freshScope());
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
  return harness;
}
