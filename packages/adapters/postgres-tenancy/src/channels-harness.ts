// What the `channels` suites need on top of the shared container: a fresh tenant
// chain per suite, and the FIVE peer rows this package is not the writer of.
//
// THE TENANT CHAIN GOES THROUGH THE PORT. `Organization`, `Project` and
// `Environment` are `tenancy`'s rows and `tenancy`'s canonical store is this
// same directory (ADR M0.3 §15), so a scope is created by calling
// `saveOrganization`, `saveProject` and `saveEnvironment` rather than by writing
// SQL. A fresh chain per suite is what keeps one suite's connections out of
// another's scoped reads.
//
// `Agent`, `Credential`, `Entity`, `EndUser` AND `Thread` CANNOT, and that is
// the interesting half. `agents` owns `Agent`, `secrets` owns `Credential`,
// `tenancy` owns `Entity`, `identity-access` owns `EndUser` and `conversations`
// owns `Thread`. Only `tenancy` has an entry in `CANONICAL_STORE_ADAPTERS` among
// those five, and `Entity` is not on `TenancyRepository`'s write surface here, so
// `sole-writer.mjs` refuses a write to four of the five from this directory —
// correctly, and the refusal is the gate doing its job rather than an obstacle to
// route around. All five are nonetheless real foreign keys the six rows under
// test point at, and four of them are checked by `enforce_domain_ancestry`:
// `ChannelConnection.entityId` must be in the environment's PROJECT,
// `defaultAgentId` likewise, `credentialId` must be in the ENVIRONMENT, and a
// link's `Thread` must be in the same environment as its connection or its app's.
//
// They are therefore seeded THROUGH THE SAME OUT-OF-BAND MECHANISM the tenancy
// and cost suites use — `prisma db execute` — rather than through any client this
// package holds. Piped on standard input rather than read from a file, because
// every row here hangs off an environment minted per suite and a static file
// cannot name one.
//
// A `CredentialSecretVersion` COMES WITH EACH CREDENTIAL, and its `secretRevision`
// is a PARAMETER rather than a constant. That number is the third axis of
// `RefreshExpectation` and the one `ChannelInstallation` has no column for, so a
// suite that could not move it could not tell a correct projection from a
// hard-coded one. Its three length checks — 32-byte salt, 12-byte nonce, 16-byte
// tag — are what make the envelope below look the way it does.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type {
  ChannelsRepository,
  EnvironmentScope,
} from "@platos/context-channels/application/ports/index.js";
import { asIdentifier, environmentScope } from "@platos/context-channels/application/ports/index.js";
import type { EnvironmentId, ProjectId, Slug } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyHarness } from "./harness.js";
import { AT, startTenancyHarness } from "./harness.js";

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

/** How a seeded credential should look to the ancestry rule and the projection. */
export interface SeededCredential {
  /** The active version's `secretRevision`. The projection must read THIS. */
  readonly secretRevision?: number;
  /** True to seed a credential with no `CredentialSecretVersion` at all. */
  readonly withoutSecretVersion?: boolean;
  /** True to put the credential in NO environment this scope owns. */
  readonly foreignEnvironmentId?: string;
}

/** A seeded thread and the two rows its ancestry required. */
export interface SeededThread {
  readonly threadId: string;
  readonly agentId: string;
  readonly endUserId: string;
}

export interface ChannelsHarness {
  readonly base: TenancyHarness;
  readonly repository: ChannelsRepository;
  /** A brand-new organization, project and environment, through the tenancy port. */
  freshScope(): Promise<EnvironmentScope>;
  /** An `Agent` in this scope's project. Returns its id. */
  seedAgent(scope: EnvironmentScope): Promise<string>;
  /** An `Entity` in this scope's project. Returns its id. */
  seedEntity(scope: EnvironmentScope): Promise<string>;
  /** A `Credential` in this scope's environment. Returns its id. */
  seedCredential(scope: EnvironmentScope, shape?: SeededCredential): Promise<string>;
  /** An `EndUser` in this scope's organization. Returns its id. */
  seedEndUser(scope: EnvironmentScope): Promise<string>;
  /** A `Thread` in this scope's environment, with the agent it runs on. */
  seedThread(scope: EnvironmentScope): Promise<SeededThread>;
  /**
   * A `Turn` on a seeded thread, which needs an `AgentVersion` of that thread's
   * OWN agent: the ancestry rule joins the two and refuses a turn whose version
   * belongs to a different agent. Returns the turn's id — the only value
   * `ChannelEventInbox.turnId` may hold, since it is a foreign key.
   */
  seedTurn(thread: SeededThread): Promise<string>;
  /** Rows this package may not write, applied by the ORM's own CLI. */
  applyPeerRows(sql: string): void;
  stop(): Promise<void>;
}

export async function startChannelsHarness(): Promise<ChannelsHarness> {
  const base = await startTenancyHarness();
  const repository = base.adapter as unknown as ChannelsRepository;
  let versionNumber = 0;

  function applyPeerRows(sql: string): void {
    execFileSync(prismaBinary, ["db", "execute", "--url", base.databaseUrl, "--stdin"], {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL: base.databaseUrl },
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  const harness: ChannelsHarness = {
    base,
    repository,
    applyPeerRows,

    async freshScope(): Promise<EnvironmentScope> {
      // The WHOLE fresh identifier, not a slice of it: `Organization.slug` is
      // UNIQUE installation-wide and `freshId` varies only in its LAST group.
      const organizationId = await base.seedOrganization(`chan-${base.freshId("0105")}`);
      const projectId = await base.seedProject(organizationId, `proj-${base.freshId("0106")}`);
      const environmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("0107"));
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

    async seedAgent(scope): Promise<string> {
      const agentId = base.freshId("0108");
      applyPeerRows(
        `INSERT INTO "Agent" ("id", "projectId", "name", "slug", "isActive", "createdAt", "updatedAt")
         VALUES ('${agentId}', '${scope.projectId}', 'routing target', 'route-${agentId.slice(-8)}',
                 true, '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      );
      return agentId;
    },

    async seedEntity(scope): Promise<string> {
      const entityId = base.freshId("0109");
      applyPeerRows(
        `INSERT INTO "Entity" ("id", "projectId", "externalId", "displayName", "connectionStatus",
                               "connectionKind", "createdAt", "updatedAt")
         VALUES ('${entityId}', '${scope.projectId}', 'ext-${entityId.slice(-8)}', 'workspace',
                 'CONNECTED', 'MCP', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      );
      return entityId;
    },

    async seedCredential(scope, shape: SeededCredential = {}): Promise<string> {
      const credentialId = base.freshId("010a");
      const versionId = base.freshId("010b");
      const environmentId = shape.foreignEnvironmentId ?? scope.environmentId;
      const statements = [
        // The NAME varies per credential because `Credential` is unique on
        // `(environmentId, kind, name)`.
        `INSERT INTO "Credential" ("id", "environmentId", "kind", "name", "createdAt", "updatedAt")
         VALUES ('${credentialId}', '${environmentId}', 'CHANNEL_SECRET', 'channel ${credentialId}',
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      ];
      if (shape.withoutSecretVersion !== true) {
        statements.push(
          // The three length checks are why these are `decode(repeat(...))`
          // rather than readable placeholders: 32 bytes of salt, 12 of nonce and
          // 16 of tag, exactly, or the row is refused.
          `INSERT INTO "CredentialSecretVersion"
             ("id", "credentialId", "secretRevision", "formatVersion", "rootKeyVersion",
              "salt", "nonce", "ciphertext", "authTag", "createdAt")
           VALUES ('${versionId}', '${credentialId}', ${String(shape.secretRevision ?? 1)}, 1, 1,
                   decode(repeat('a1', 32), 'hex'), decode(repeat('b2', 12), 'hex'),
                   decode(repeat('c3', 8), 'hex'), decode(repeat('d4', 16), 'hex'),
                   '2026-05-01T09:00:00Z');`,
          `UPDATE "Credential" SET "activeSecretVersionId" = '${versionId}' WHERE "id" = '${credentialId}';`,
        );
      }
      applyPeerRows(statements.join("\n"));
      return credentialId;
    },

    async seedEndUser(scope): Promise<string> {
      const endUserId = base.freshId("010c");
      applyPeerRows(
        `INSERT INTO "EndUser" ("id", "organizationId", "displayName", "createdAt", "updatedAt")
         VALUES ('${endUserId}', '${scope.organizationId}', 'channel subject',
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      );
      return endUserId;
    },

    async seedThread(scope): Promise<SeededThread> {
      // A thread needs an agent AND an end user, and the ancestry rule checks
      // BOTH against the tree: the agent against the environment's project, the
      // end user against that project's organization. Seeding them here rather
      // than making a caller remember is what keeps every link case one line.
      const agentId = await harness.seedAgent(scope);
      const endUserId = await harness.seedEndUser(scope);
      const threadId = base.freshId("010d");
      applyPeerRows(
        `INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "createdAt", "updatedAt")
         VALUES ('${threadId}', '${scope.environmentId}', '${agentId}', '${endUserId}',
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      );
      return { threadId, agentId, endUserId };
    },

    async seedTurn(thread): Promise<string> {
      const versionId = base.freshId("010e");
      const turnId = base.freshId("010f");
      // TWO UNIQUES, ONE COUNTER. `AgentVersion` is UNIQUE on
      // `(agentId, versionNumber)` and `Turn` on `(threadId, sequence)`, so a
      // SECOND turn on the same thread collides on both unless each call moves.
      // The counter varies per call rather than per agent because two turns on
      // one thread is the case that found this, and a per-agent map would have
      // hidden it behind a lookup.
      versionNumber += 1;
      applyPeerRows(
        [
          `INSERT INTO "AgentVersion" ("id", "agentId", "versionNumber", "model", "createdBy", "createdAt")
           VALUES ('${versionId}', '${thread.agentId}', ${String(versionNumber)}, 'model-x', 'suite',
                   '2026-05-01T09:00:00Z');`,
          `INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence", "createdAt")
           VALUES ('${turnId}', '${thread.threadId}', '${versionId}', 'CURRENT',
                   ${String(versionNumber)}, '2026-05-01T09:00:00Z');`,
        ].join("\n"),
      );
      return turnId;
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
  return harness;
}
