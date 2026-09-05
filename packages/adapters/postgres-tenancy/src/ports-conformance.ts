// One scenario for tenancy's other five ports, so the in-memory doubles and
// this adapter can be asked the SAME questions and their answers compared.
//
// It is the same instrument tranche 1 built for the repository and tranche 2 for
// the identity-access stores, pointed at the five ports that are not stores. The
// reason it is worth pointing there is that these five are exactly where a
// double is most convincing and least like a database: a lock is a method that
// returns a boolean, a counter is a number that goes up, and an in-memory
// version of either is trivially correct. Everything that makes them hard —
// whether the lock BLOCKS, whether the counter's read-modify-write is atomic,
// whether a token digest is a shape PostgreSQL will accept — is invisible to a
// scenario like this one, which is why `locks.integration.test.ts` exists beside
// it and why this file says so here rather than implying coverage it has not
// got.
//
// WHAT IS NORMALISED, AND IT IS ONE THING. A minted invitation token is random
// in the adapter and a counter in the double, so no VALUE of a token or a digest
// is recorded. What is recorded is what both must be true of: that digesting a
// minted token reproduces the digest the mint returned, that the digest is
// stable, that two mints differ, and that the digest is not the token. Nothing
// else is normalised: booleans, counts, ordering and null-versus-absent compare
// literally.
//
// ONE PROPERTY IS DELIBERATELY LEFT OUT of the shared comparison and asserted
// separately, because the two stores DISAGREE about it and the disagreement is a
// finding rather than noise: the double's digest is `digest:plt_inv_1`, and
// `OrganizationInvitation_tokenHash_check` refuses anything but 64 lowercase hex
// characters. Recording it here would have made this scenario red for a reason
// that has nothing to do with the adapter; recording it nowhere would have lost
// the finding. It is pinned in `ports-conformance.integration.test.ts`, on both
// stores, with the constraint's own refusal beside it.

import type {
  EmailAddress,
  EnvironmentAccessKeyRevocationCounter,
  EnvironmentId,
  InvitationTokenIssuer,
  OperatorDirectory,
  OperatorSessionRevoker,
  OrganizationId,
  TenancyLocks,
  UnitOfWork,
  UserId,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";

/** The five ports under comparison, named exactly as `TenancyDependencies` names them. */
export interface TenancyPortBundle {
  readonly locks: TenancyLocks;
  readonly sessionRevoker: OperatorSessionRevoker;
  readonly accessKeyRevocation: EnvironmentAccessKeyRevocationCounter;
  readonly invitationTokens: InvitationTokenIssuer;
  readonly operators: OperatorDirectory;
}

/** Every identifier the scenario needs, supplied so each store can use its own. */
export interface PortsConformanceIds {
  readonly organizationId: string;
  /** Archived. `lockOrganizationForUpdate` must refuse it. */
  readonly archivedOrganizationId: string;
  readonly absentOrganizationId: string;
  readonly environmentId: string;
  readonly absentEnvironmentId: string;
  /** Holds live operator sessions the revoker must end. */
  readonly memberUserId: string;
  readonly memberEmail: string;
  readonly absentUserId: string;
}

/** The instant every order in the scenario is stamped with. */
export const PORTS_AT = new Date("2026-05-01T09:00:00.000Z");

/** How many live sessions the member holds before the scenario revokes them. */
export const SEEDED_LIVE_SESSIONS = 2;

export type PortsObservation = Record<string, unknown>;

export async function runTenancyPortsConformance(
  ports: TenancyPortBundle,
  unitOfWork: UnitOfWork,
  ids: PortsConformanceIds,
): Promise<PortsObservation> {
  const organizationId = asIdentifier<OrganizationId>(ids.organizationId);
  const archivedOrganizationId = asIdentifier<OrganizationId>(ids.archivedOrganizationId);
  const absentOrganizationId = asIdentifier<OrganizationId>(ids.absentOrganizationId);
  const environmentId = asIdentifier<EnvironmentId>(ids.environmentId);
  const absentEnvironmentId = asIdentifier<EnvironmentId>(ids.absentEnvironmentId);
  const memberUserId = asIdentifier<UserId>(ids.memberUserId);
  const absentUserId = asIdentifier<UserId>(ids.absentUserId);
  const email = asIdentifier<EmailAddress>(ids.memberEmail);
  const observed: PortsObservation = {};

  // --- the token issuer, which needs no transaction and no rows -------------
  const first = ports.invitationTokens.mint();
  const second = ports.invitationTokens.mint();
  observed.mintRoundTrips = ports.invitationTokens.digest(first.token) === first.digest;
  observed.digestIsStable =
    ports.invitationTokens.digest(first.token) === ports.invitationTokens.digest(first.token);
  observed.mintsDiffer = first.token !== second.token && first.digest !== second.digest;
  observed.digestIsNotTheToken = String(first.digest) !== first.token;

  // --- the operator directory, a read with no transaction of its own --------
  observed.knownAccount = await ports.operators.findAccount(memberUserId);
  observed.unknownAccount = await ports.operators.findAccount(absentUserId);

  await unitOfWork.run(async (transaction) => {
    // --- the locks ---------------------------------------------------------
    observed.lockLiveOrganization = await ports.locks.lockOrganizationForUpdate(
      organizationId,
      transaction,
    );
    // The oracle's condition is existence AND unarchived, and these two cases
    // are recorded separately because a single "false" would not distinguish
    // an implementation that dropped the `archivedAt IS NULL` clause from one
    // that kept it.
    observed.lockArchivedOrganization = await ports.locks.lockOrganizationForUpdate(
      archivedOrganizationId,
      transaction,
    );
    observed.lockAbsentOrganization = await ports.locks.lockOrganizationForUpdate(
      absentOrganizationId,
      transaction,
    );
    await ports.locks.lockInvitationSlot(organizationId, email, transaction);
    observed.invitationSlotReturned = true;
    observed.lockLiveEnvironment = await ports.locks.lockEnvironmentForUpdate(
      environmentId,
      transaction,
    );
    observed.lockAbsentEnvironment = await ports.locks.lockEnvironmentForUpdate(
      absentEnvironmentId,
      transaction,
    );

    // --- the revocation counter -------------------------------------------
    observed.generationBefore = await ports.accessKeyRevocation.read(environmentId);
    observed.firstBump = await ports.accessKeyRevocation.bump(environmentId, transaction);
    // Read back INSIDE the transaction. A read that went to the pool would not
    // see the bump, and would answer the value from before it — which is the
    // whole reason `TenancyTransactions.reader()` prefers the ambient frame.
    observed.generationAfterFirstBump = await ports.accessKeyRevocation.read(environmentId);
    observed.secondBump = await ports.accessKeyRevocation.bump(environmentId, transaction);
    observed.generationForAbsentEnvironment =
      await ports.accessKeyRevocation.read(absentEnvironmentId);

    // --- the session revoker ----------------------------------------------
    const order = {
      userId: memberUserId,
      cause: "membership-role-changed",
      revokedAt: PORTS_AT,
      includeImpersonatedSessions: true,
    } as const;
    observed.firstRevoke = await ports.sessionRevoker.revoke(order, transaction);
    // The SECOND call is the point. A revoker whose filter dropped
    // `revokedAt IS NULL` would report the same count twice and a caller
    // recording "how many sessions this change ended" would double-count.
    observed.secondRevoke = await ports.sessionRevoker.revoke(order, transaction);
  });

  // Outside the transaction, so this read proves the bumps COMMITTED rather
  // than merely having been visible to the transaction that made them.
  observed.generationAfterCommit = await ports.accessKeyRevocation.read(environmentId);
  return observed;
}
