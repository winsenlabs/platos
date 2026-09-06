// What the `files` suites need on top of the shared container: a tenant chain
// per suite, and the FIVE peer rows this context's two tables hang off.
//
// THE TENANT CHAIN GOES THROUGH THE PORT. `Organization`, `Project` and
// `Environment` are `tenancy`'s rows and `tenancy`'s canonical store is this
// same directory (ADR M0.3 §15), so a scope is created by calling
// `saveOrganization`, `saveProject` and `saveEnvironment` rather than by writing
// SQL.
//
// THE PEER CHAIN CANNOT, AND `MessageAttachment_ancestry` IS WHY IT IS A CHAIN
// RATHER THAN A LIST:
//
//   Agent        -> Project          (the environment's project, exactly)
//   AgentVersion -> Agent            (a `Turn` cannot exist without one)
//   EndUser      -> Organization     (the environment's organization, exactly)
//   Thread       -> Environment, Agent, EndUser — all three, and the attachment
//                   must name the SAME three
//   Turn         -> Thread, AgentVersion
//
// `Agent` and `AgentVersion` are `agents`' rows (ADR M0.3 §1 row 5), `EndUser` is
// `identity-access`' (row 1), and `Thread` and `Turn` are `conversations`' (row
// 16). All three contexts are delegated to this same directory, so all five
// COULD have gone through their own repositories. They do not, deliberately, for
// the reason `conversations-harness.ts` gives of its own: the fixture would then
// have TWO mechanisms for one chain — half through ports belonging to contexts
// this suite is not testing, half through SQL — and a fixture whose failures can
// come from either is a fixture that has to be debugged before a suite can be
// read.
//
// `applyPeerRows` IS ALSO WHAT PLANTS THE ROWS THIS STORE REFUSES TO WRITE, and
// that is the other half of its job. A `MessageAttachment` with a negative
// `bytes`, an `Artifact` at `revision` 0, and an `Artifact` whose `metadata` is a
// JSON array are all rows an OLDER BINARY could have written or a CHECK could
// still refuse — and the only way to prove which is which is to plant them. The
// tool that can is the ORM's own CLI, which is runtime and therefore outside the
// sole-writer scanner's scope by construction.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type {
  AttachmentScope,
  EnvironmentScope,
  FilesRepository,
  ThreadScope,
  TransactionScope,
} from "@platos/context-files/application/ports/index.js";
import { asIdentifier } from "@platos/context-files/application/ports/index.js";
import type { EnvironmentId, ProjectId, Slug } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";
import { runResult } from "@platos/kernel";
import type { NotResult } from "@platos/kernel";

import type { TenancyHarness } from "./harness.js";
import { AT, startTenancyHarness } from "./harness.js";

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

const STAMP = "'2026-05-01T09:00:00Z'";

/** One tenant, its peers, and the two scopes every case is addressed with. */
export interface FilesChain {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  /**
   * A SECOND environment of the SAME project, holding nothing.
   *
   * It exists so the ENVIRONMENT clause of the erasure predicate is falsifiable.
   * An organization-level count and an environment-level count over a tenant with
   * one environment are the same number, so a selector that had dropped its
   * environment clause would answer correctly at both levels; naming an
   * environment that holds none of the subject's rows is the only shape that can
   * tell them apart.
   */
  readonly secondEnvironmentId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly endUserId: string;
  /** A SECOND subject in the SAME organization, with a thread of its own. */
  readonly secondEndUserId: string;
  readonly threadId: string;
  /** The second subject's thread. Same environment, same agent, other owner. */
  readonly secondThreadId: string;
  /**
   * A THIRD thread with the SAME environment, agent AND end user.
   *
   * It exists for one case and could not be replaced by either of the other two.
   * `MessageAttachment_owner_immutable` and `MessageAttachment_ancestry` are both
   * BEFORE UPDATE rules, and PostgreSQL fires those in ALPHABETICAL order by
   * name — so `_ancestry` runs first and refuses every owner move that breaks
   * the chain, which is every move to a thread of a different subject or a
   * different agent. The only owner change that survives the ancestry rule and
   * reaches the immutability rule is a move to a SIBLING thread of the same
   * subject on the same agent, and this is that thread.
   */
  readonly thirdThreadId: string;
  readonly turnId: string;
  /** A SECOND turn of the SAME thread. The binding-conflict witness. */
  readonly secondTurnId: string;
  readonly environment: EnvironmentScope;
  readonly thread: ThreadScope;
  /** The second subject's thread, as a scope. */
  readonly secondThread: ThreadScope;
  readonly attachment: AttachmentScope;
  readonly secondAttachment: AttachmentScope;
}

export interface FilesHarness {
  readonly base: TenancyHarness;
  readonly repository: FilesRepository;
  freshChain(): Promise<FilesChain>;
  /** Rows this package may not write, or refuses to, applied by the ORM's own CLI. */
  applyPeerRows(sql: string): void;
  /** Open one transaction over the adapter's own ambient frame. */
  run<Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>): Promise<Value>;
  statements(): readonly string[];
  resetStatements(): void;
  stop(): Promise<void>;
}

export async function startFilesHarness(): Promise<FilesHarness> {
  const base = await startTenancyHarness();
  const repository = base.adapter as unknown as FilesRepository;

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
            VALUES ('${agentId}', '${projectId}', 'files agent', 'files-${agentId.slice(-12)}', true, ${STAMP}, ${STAMP});`;
  }

  function versionSql(versionId: string, agentId: string): string {
    // The five JSON columns are spelled out because each carries its own
    // `_json_root` CHECK — three arrays, two objects — and `toolsBlockConfig`
    // carries a SECOND check forbidding an `enabledTools` key.
    return `INSERT INTO "AgentVersion"
              ("id", "agentId", "versionNumber", "model", "maxSteps", "contextLimit",
               "toolDefaultPolicy", "promptBlocks", "dynamicBlocks", "toolsBlockConfig",
               "modelRoutes", "memoryConfig", "createdBy", "createdAt")
            VALUES ('${versionId}', '${agentId}', 1, 'anthropic:claude-test', 10, 128000,
                    'NONE', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
                    'fixture', ${STAMP});`;
  }

  function threadSql(
    threadId: string,
    environmentId: string,
    agentId: string,
    endUserId: string,
  ): string {
    return `INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "status",
                                  "compactionState", "createdAt", "updatedAt")
            VALUES ('${threadId}', '${environmentId}', '${agentId}', '${endUserId}',
                    'ACTIVE', 'IDLE', ${STAMP}, ${STAMP});`;
  }

  function turnSql(turnId: string, threadId: string, versionId: string, sequence: number): string {
    // `Turn_usage_check` demands `sequence > 0`, so the fixture counts from one.
    return `INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence",
                                "status", "createdAt")
            VALUES ('${turnId}', '${threadId}', '${versionId}', 'CURRENT', ${String(sequence)},
                    'SUCCEEDED', ${STAMP});`;
  }

  const harness: FilesHarness = {
    base,
    repository,
    applyPeerRows,
    statements: () => base.statements(),
    resetStatements: () => base.resetStatements(),

    async run(work) {
      return base.adapter.unitOfWork.run(work);
    },

    async freshChain(): Promise<FilesChain> {
      // The WHOLE fresh identifier, not a slice: `Organization.slug` is UNIQUE
      // installation-wide and `freshId` varies only in its LAST group, so a
      // slice of the middle is the same string on every call.
      const organizationId = await base.seedOrganization(`fls-${base.freshId("0031")}`);
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

      const secondEnvironmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("003d"));
      await base.adapter.unitOfWork.run((transaction) =>
        base.adapter.saveEnvironment(
          {
            id: secondEnvironmentId,
            projectId: projectId as ProjectId,
            slug: asTenancyIdentifier<Slug>("staging"),
            name: "staging",
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

      const agentId = base.freshId("0034");
      const agentVersionId = base.freshId("0035");
      const endUserId = base.freshId("0036");
      const secondEndUserId = base.freshId("0037");
      const threadId = base.freshId("0038");
      const secondThreadId = base.freshId("0039");
      const thirdThreadId = base.freshId("003c");
      const turnId = base.freshId("003a");
      const secondTurnId = base.freshId("003b");
      applyPeerRows(
        [
          agentSql(agentId, projectId),
          versionSql(agentVersionId, agentId),
          `INSERT INTO "EndUser" ("id", "organizationId", "displayName", "createdAt", "updatedAt")
           VALUES ('${endUserId}', '${organizationId}', 'the subject', ${STAMP}, ${STAMP});`,
          // The SECOND subject shares the organization on purpose: an erasure
          // addressed at the organization must destroy one subject's rows and
          // leave the other's, and a second subject in a second tenant could not
          // tell that apart from the containment predicate doing the work.
          `INSERT INTO "EndUser" ("id", "organizationId", "displayName", "createdAt", "updatedAt")
           VALUES ('${secondEndUserId}', '${organizationId}', 'another subject', ${STAMP}, ${STAMP});`,
          threadSql(threadId, environmentId, agentId, endUserId),
          threadSql(secondThreadId, environmentId, agentId, secondEndUserId),
          threadSql(thirdThreadId, environmentId, agentId, endUserId),
          turnSql(turnId, threadId, agentVersionId, 1),
          turnSql(secondTurnId, threadId, agentVersionId, 2),
        ].join("\n"),
      );

      const environment: EnvironmentScope = {
        level: "environment",
        organizationId: asIdentifier(organizationId),
        projectId: asIdentifier(projectId),
        environmentId: asIdentifier(environmentId),
      };
      const thread: ThreadScope = { environment, threadId: asIdentifier(threadId) };
      const secondThread: ThreadScope = { environment, threadId: asIdentifier(secondThreadId) };
      return {
        organizationId,
        projectId,
        environmentId,
        secondEnvironmentId,
        agentId,
        agentVersionId,
        endUserId,
        secondEndUserId,
        threadId,
        secondThreadId,
        thirdThreadId,
        turnId,
        secondTurnId,
        environment,
        thread,
        secondThread,
        attachment: {
          environment,
          threadId: asIdentifier(threadId),
          owner: { endUserId: asIdentifier(endUserId), agentId: asIdentifier(agentId) },
        },
        secondAttachment: {
          environment,
          threadId: asIdentifier(secondThreadId),
          owner: { endUserId: asIdentifier(secondEndUserId), agentId: asIdentifier(agentId) },
        },
      };
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
  return harness;
}
