// What the `jobs` suites need on top of the shared container: a fresh tenant
// chain per suite, and the THREE peer rows an approval hangs off.
//
// THE TENANT CHAIN GOES THROUGH THE PORT. `Organization`, `Project` and
// `Environment` are `tenancy`'s rows and `tenancy`'s canonical store is this
// same directory (ADR M0.3 §15), so a scope is created by calling
// `saveOrganization`, `saveProject` and `saveEnvironment` rather than by writing
// SQL. A fresh chain per suite is what keeps a listing that returns everything
// in an environment from seeing another suite's rows — and it is what makes
// `findScopesWithPending`, the one read here that crosses tenants, measurable at
// all.
//
// THE PEER CHAIN DOES NOT, AND `enforce_domain_ancestry` IS WHY IT IS A CHAIN.
// The trigger fires BEFORE INSERT OR UPDATE on `AgentApproval` and demands three
// things at once: the `agentId` names an `Agent` in the environment's PROJECT,
// the `threadId` names a `Thread` in the ENVIRONMENT, and the `turnId` names a
// `Turn` in THAT thread. So an approval cannot be seeded against an agent from
// another project or a turn from another conversation, which is exactly the
// cross-tenant case the constraint proofs need — and the only way to build it is
// to seed a second, foreign chain, which `foreignChain()` below does.
//
// `Agent`, `AgentVersion`, `EndUser`, `Thread` and `Turn` ARE ALL WRITABLE FROM
// THIS DIRECTORY — `agents`, `identity-access` and `conversations` are all
// delegated to it — and they still go through `prisma db execute`, deliberately.
// A fixture with TWO mechanisms for one chain, half of it through ports
// belonging to contexts this suite is not testing, is a fixture that has to be
// debugged before a suite can be read. `governance-harness.ts` records the same
// decision for the same five rows.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type { EnvironmentScope } from "@platos/context-jobs/application/ports/index.js";
import { asIdentifier, environmentScope } from "@platos/context-jobs/application/ports/index.js";
import type { EnvironmentId, ProjectId, Slug } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { JobsStores } from "./jobs-repository.js";
import type { TenancyHarness } from "./harness.js";
import { AT, startTenancyHarness } from "./harness.js";

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

/** One seeded conversation, and everything an approval may point at. */
export interface ApprovalPeers {
  readonly scope: EnvironmentScope;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly endUserId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly secondTurnId: string;
}

export interface JobsHarness {
  readonly base: TenancyHarness;
  readonly stores: JobsStores;
  /** A brand-new organization, project and environment, through the tenancy port. */
  freshScope(): Promise<EnvironmentScope>;
  /** An agent, a version, an end user, a thread and two turns inside `scope`. */
  seedPeers(scope: EnvironmentScope): Promise<ApprovalPeers>;
  /** A whole second tenant with its own chain, for the cross-tenant proofs. */
  foreignPeers(): Promise<ApprovalPeers>;
  /** Rows and statements this package's ports do not issue, applied by the ORM's CLI. */
  applyPeerRows(sql: string): void;
  stop(): Promise<void>;
}

const STAMP = "'2026-05-01T09:00:00Z'";

export async function startJobsHarness(): Promise<JobsHarness> {
  const base = await startTenancyHarness();
  const stores: JobsStores = { jobs: base.adapter.jobs, approvals: base.adapter.approvals };

  function applyPeerRows(sql: string): void {
    execFileSync(prismaBinary, ["db", "execute", "--url", base.databaseUrl, "--stdin"], {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL: base.databaseUrl },
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  const harness: JobsHarness = {
    base,
    stores,
    applyPeerRows,

    async freshScope(): Promise<EnvironmentScope> {
      // The WHOLE fresh identifier, not a slice: `Organization.slug` is UNIQUE
      // installation-wide and `freshId` varies only in its LAST group, so a
      // slice of the middle is the same string on every call.
      const organizationId = await base.seedOrganization(`jobs-${base.freshId("0031")}`);
      const projectId = await base.seedProject(organizationId, `proj-${base.freshId("0032")}`);
      const environmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("0033"));
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

    async seedPeers(scope: EnvironmentScope): Promise<ApprovalPeers> {
      const agentId = base.freshId("0034");
      const agentVersionId = base.freshId("0035");
      const endUserId = base.freshId("0036");
      const threadId = base.freshId("0037");
      const turnId = base.freshId("0038");
      const secondTurnId = base.freshId("0039");
      applyPeerRows(
        [
          `INSERT INTO "Agent" ("id", "projectId", "name", "slug", "isActive", "createdAt", "updatedAt")
           VALUES ('${agentId}', '${scope.projectId}', 'approving agent', 'appr-${agentId.slice(-12)}', true, ${STAMP}, ${STAMP});`,
          // The five JSON columns are spelled out because each carries its own
          // `_json_root` CHECK — three arrays, two objects — and
          // `toolsBlockConfig` carries a SECOND check forbidding an
          // `enabledTools` key. A version seeded with the wrong root is refused
          // by the database, not by Prisma.
          `INSERT INTO "AgentVersion"
             ("id", "agentId", "versionNumber", "model", "maxSteps", "contextLimit",
              "toolDefaultPolicy", "promptBlocks", "dynamicBlocks", "toolsBlockConfig",
              "modelRoutes", "memoryConfig", "createdBy", "createdAt")
           VALUES ('${agentVersionId}', '${agentId}', 1, 'anthropic:test-approver', 10, 128000,
                   'NONE', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
                   'fixture', ${STAMP});`,
          `INSERT INTO "EndUser" ("id", "organizationId", "displayName", "createdAt", "updatedAt")
           VALUES ('${endUserId}', '${scope.organizationId}', 'requester', ${STAMP}, ${STAMP});`,
          `INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "status", "createdAt", "updatedAt")
           VALUES ('${threadId}', '${scope.environmentId}', '${agentId}', '${endUserId}', 'ACTIVE', ${STAMP}, ${STAMP});`,
          // `sequence` starts at 1 because `Turn_usage_check` demands
          // `"sequence" > 0`, and the two turns differ in it because
          // `@@unique([threadId, sequence])` would otherwise refuse the second.
          `INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence",
                               "inputText", "outputText", "status", "createdAt")
           VALUES ('${turnId}', '${threadId}', '${agentVersionId}', 'CURRENT', 1,
                   'delete the production database', 'awaiting approval', 'PENDING', ${STAMP});`,
          `INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence",
                               "inputText", "outputText", "status", "createdAt")
           VALUES ('${secondTurnId}', '${threadId}', '${agentVersionId}', 'CURRENT', 2,
                   'and drop the backups', 'awaiting approval', 'PENDING', ${STAMP});`,
        ].join("\n"),
      );
      return { scope, agentId, agentVersionId, endUserId, threadId, turnId, secondTurnId };
    },

    async foreignPeers(): Promise<ApprovalPeers> {
      return harness.seedPeers(await harness.freshScope());
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
  return harness;
}
