// `TenancyLocks` — the two serialization primitives the oracle relies on,
// named rather than hidden inside a repository method.
//
// They are ports because both are database facilities and neither is
// expressible in a pure layer, and they are SEPARATE from `TenancyRepository`
// because they are not reads or writes: forgetting to take them does not fail a
// test, it produces a race that only appears under concurrency. Making them an
// explicit dependency means a use case that needs one cannot be written without
// naming it.

import type { EnvironmentId, OrganizationId, TransactionScope } from "@platos/kernel";

import type { EmailAddress } from "../../domain/index.js";

export interface TenancyLocks {
  /**
   * `SELECT id FROM "Organization" WHERE id = ? AND "archivedAt" IS NULL FOR UPDATE`.
   *
   * Serializes role changes per organization so two concurrent owner demotions
   * cannot each observe the other owner and both commit, which would leave the
   * organization with none. Returns false when the row is missing or archived —
   * the oracle's `organization.length !== 1` case — so the caller denies rather
   * than proceeding unserialized.
   */
  lockOrganizationForUpdate(
    organizationId: OrganizationId,
    transaction: TransactionScope,
  ): Promise<boolean>;

  /**
   * `pg_advisory_xact_lock(hashtextextended('organization-invitation:<org>:<email>', 0))`.
   *
   * Taken before an invitation is superseded and re-issued. The partial unique
   * index already makes a second live invitation impossible; this lock is what
   * turns a concurrent second invite into a WAIT instead of a raw unique
   * violation surfacing to the caller. Advisory and transaction-scoped: it is
   * released by commit or rollback, never explicitly.
   */
  lockInvitationSlot(
    organizationId: OrganizationId,
    email: EmailAddress,
    transaction: TransactionScope,
  ): Promise<void>;

  /**
   * `SELECT id, "accessKeyRevocationVersion" FROM "Environment" WHERE id = ? FOR UPDATE`.
   *
   * The row lock the access-key revocation counter is incremented under, so a
   * rotation that read an older generation is superseded rather than racing.
   */
  lockEnvironmentForUpdate(
    environmentId: EnvironmentId,
    transaction: TransactionScope,
  ): Promise<boolean>;
}
