// The fixture tranche 3's suites share, over the SAME container the other two
// tranches use.
//
// It builds on `startIdentityHarness` rather than starting a third PostgreSQL,
// because the whole argument of ADR M0.3 §15 is that there is one database
// behind one client, and a suite that stood up its own container would be
// measuring an arrangement that does not ship. It adds exactly the rows the five
// ports need and that the ports themselves cannot create: an ARCHIVED
// organization, live `OperatorSession` rows, and an `Environment` row written
// the way a release older than the fence migration wrote one.
//
// THE THIRD OF THOSE IS THE EXPAND/CONTRACT FIXTURE, and it is raw SQL for a
// reason that is not convenience. `accessKeyRevocationVersion` arrived in
// `migrations/20260825070000_access_key_revocation_fence`, so a row written by
// the release before it carried no such column. The generated client cannot
// express that write — the column is non-optional in its types — so the only way
// to produce the row an upgraded install actually has is to write it in SQL,
// omitting the column and letting the DEFAULT the migration installed do what it
// does in production.
//
// IT FAILS WHEN DOCKER IS ABSENT rather than skipping, inherited from the
// harness it builds on.

import type {
  OperatorSessionId,
  UserId as IdentityUserId,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier as asIdentityIdentifier } from "@platos/context-identity-access/application/ports/index.js";

import type { PostgresTenancyAdapter } from "./adapter.js";
import type { TenancyDatabaseClient } from "./client.js";
import { envId, orgId, projId, slugOf } from "./harness.js";
import { startIdentityHarness, type IdentityHarness } from "./identity-harness.js";
import type { TenancyPortBundle } from "./ports-conformance.js";

const AT = new Date("2026-05-01T09:00:00.000Z");
const EXPIRES = new Date("2026-06-01T09:00:00.000Z");

export interface PortsHarness {
  readonly client: TenancyDatabaseClient;
  readonly adapter: PostgresTenancyAdapter;
  /** The five ports, as `TenancyDependencies` names them. */
  readonly ports: TenancyPortBundle;
  statements(): readonly string[];
  resetStatements(): void;
  freshId(kind: string): string;
  /** An organization, live or archived, through the tenancy repository. */
  seedOrganization(slug: string, archived?: boolean): Promise<string>;
  /** A project and an environment under an organization, both live. */
  seedEnvironment(organizationId: string, slug: string): Promise<string>;
  /**
   * An `Environment` row written WITHOUT `accessKeyRevocationVersion`, as a
   * release older than the fence migration wrote one. See the header.
   */
  seedPreFenceEnvironment(organizationId: string, slug: string): Promise<string>;
  seedUser(address: string): Promise<string>;
  /**
   * A live `OperatorSession`. Returns its id.
   *
   * The token hash is minted by the harness from a counter rather than taken
   * from the caller, because `OperatorSession.tokenHash` is UNIQUE and carries
   * `^[0-9a-f]{64}$`: a caller-chosen label collides the second time a suite
   * seeds "the same" session, and the failure surfaces as a unique violation
   * three cases away from the one that caused it.
   */
  seedSession(input: {
    readonly userId: string;
    readonly impersonatedUserId?: string;
    readonly parentSessionId?: string;
  }): Promise<string>;
  /** Whether a session is still live, read straight from the row. */
  sessionRevokedAt(sessionId: string): Promise<Date | null>;
  stop(): Promise<void>;
}

/** A `*Hash` value that satisfies the migrations' `^[0-9a-f]{64}$` checks. */
export const hashOf = (ordinal: number): string => ordinal.toString(16).padStart(64, "0");

export async function startPortsHarness(): Promise<PortsHarness> {
  const base: IdentityHarness = await startIdentityHarness();
  const { client, adapter } = base;
  let sessions = 0;

  const harness: PortsHarness = {
    client,
    adapter,
    // The ports come OFF THE ADAPTER rather than being rebuilt here. A harness
    // that called the five factories itself would be testing five objects the
    // composition root never sees, and would in particular give them a second
    // `TenancyTransactions` — a lock on one ambient frame and the write it
    // serializes on another.
    ports: {
      locks: adapter.locks,
      sessionRevoker: adapter.sessionRevoker,
      accessKeyRevocation: adapter.accessKeyRevocation,
      invitationTokens: adapter.invitationTokens,
      operators: adapter.operators,
    },
    statements: base.statements,
    resetStatements: base.resetStatements,
    freshId: base.freshId,

    async seedOrganization(slug: string, archived = false): Promise<string> {
      const id = orgId(base.freshId("0101"));
      await adapter.unitOfWork.run((transaction) =>
        adapter.saveOrganization(
          {
            id,
            slug: slugOf(slug),
            name: slug,
            archivedAt: archived ? AT : null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        ),
      );
      return id;
    },

    async seedEnvironment(organizationId: string, slug: string): Promise<string> {
      const projectId = projId(base.freshId("0102"));
      const environmentId = envId(base.freshId("0103"));
      await adapter.unitOfWork.run(async (transaction) => {
        await adapter.saveProject(
          {
            id: projectId,
            organizationId: orgId(organizationId),
            slug: slugOf(`${slug}-project`),
            name: slug,
            archivedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        );
        await adapter.saveEnvironment(
          {
            id: environmentId,
            projectId,
            slug: slugOf(slug),
            name: slug,
            archivedAt: null,
            accessKeyRevocationVersion: 0,
            memoryFeedbackBackfillCursor: null,
            memoryFeedbackBackfillCompletedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        );
      });
      return environmentId;
    },

    async seedPreFenceEnvironment(organizationId: string, slug: string): Promise<string> {
      const projectId = projId(base.freshId("0104"));
      await adapter.unitOfWork.run((transaction) =>
        adapter.saveProject(
          {
            id: projectId,
            organizationId: orgId(organizationId),
            slug: slugOf(`${slug}-project`),
            name: slug,
            archivedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        ),
      );
      const environmentId = base.freshId("0105");
      await client.$executeRawUnsafe(
        `INSERT INTO "Environment" ("id","projectId","slug","name","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,$3,$4,$5::timestamp,$5::timestamp)`,
        environmentId,
        projectId,
        slug,
        slug,
        AT,
      );
      return environmentId;
    },

    seedUser: base.seedUser,

    async seedSession(input): Promise<string> {
      const sessionId = base.freshId("0106");
      sessions += 1;
      await adapter.operatorSessions.save({
        sessionId: asIdentityIdentifier<OperatorSessionId>(sessionId),
        tokenHash: asIdentityIdentifier(hashOf(sessions)),
        tier: "OPERATOR",
        userId: asIdentityIdentifier<IdentityUserId>(input.userId),
        impersonatedUserId:
          input.impersonatedUserId === undefined
            ? null
            : asIdentityIdentifier<IdentityUserId>(input.impersonatedUserId),
        parentSessionId:
          input.parentSessionId === undefined
            ? null
            : asIdentityIdentifier<OperatorSessionId>(input.parentSessionId),
        mfaVerifiedAt: null,
        expiresAt: EXPIRES,
        revokedAt: null,
        lastSeenAt: null,
        createdAt: AT,
      });
      return sessionId;
    },

    async sessionRevokedAt(sessionId: string): Promise<Date | null> {
      const row = await adapter.operatorSessions.findById(
        asIdentityIdentifier<OperatorSessionId>(sessionId),
      );
      return row === null ? null : row.revokedAt;
    },

    stop: base.stop,
  };
  return harness;
}
