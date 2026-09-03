// `Environment` — the leaf of the tenant tree and the key almost every other
// context is scoped by. Tenancy is sole writer.
//
// THREE COLUMNS ON THIS ROW ARE NOT TENANCY DATA. The baseline schema has
// accreted them onto `Environment` because it was the convenient row, not
// because tenancy owns the capability:
//
//   memoryFeedbackBackfillCursor       — a `memory` migration cursor
//   memoryFeedbackBackfillCompletedAt  — the same migration's completion mark
//   accessKeyRevocationVersion         — an `identity-access` optimistic-
//                                        concurrency generation for access-key
//                                        rotation
//
// The first two are inert: nothing outside the memory backfill reads them, and
// they are carried here only so a repository can round-trip the row. The third
// is a live SINGLE-WRITER VIOLATION and is called out in full on
// `EnvironmentAccessKeyRevocationCounter` in application/ports.

import type { EnvironmentId, ProjectId } from "@platos/kernel";

import type { Slug } from "./identifiers.js";

export interface EnvironmentRecord {
  readonly id: EnvironmentId;
  readonly projectId: ProjectId;
  /** Unique within the project: `@@unique([projectId, slug])`. */
  readonly slug: Slug;
  readonly name: string;
  readonly archivedAt: Date | null;
  /**
   * Incremented by identity-access's access-key revocation under an
   * `Environment` row lock, so a rotation that observed an older generation is
   * superseded rather than resurrecting a revoked key. Tenancy owns the row and
   * must therefore own the write; the port is the seam that makes that true.
   */
  readonly accessKeyRevocationVersion: number;
  /** Owned in substance by `memory`; carried so the row round-trips. */
  readonly memoryFeedbackBackfillCursor: string | null;
  /** Owned in substance by `memory`; carried so the row round-trips. */
  readonly memoryFeedbackBackfillCompletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function isEnvironmentArchived(environment: EnvironmentRecord): boolean {
  return environment.archivedAt !== null;
}

export function archiveEnvironment(environment: EnvironmentRecord, at: Date): EnvironmentRecord {
  if (environment.archivedAt !== null) return environment;
  return { ...environment, archivedAt: at, updatedAt: at };
}

export function restoreEnvironment(environment: EnvironmentRecord, at: Date): EnvironmentRecord {
  if (environment.archivedAt === null) return environment;
  return { ...environment, archivedAt: null, updatedAt: at };
}

/**
 * The one tenancy-owned mutation of `accessKeyRevocationVersion`.
 *
 * Monotonic and unconditional: the counter only ever moves forward, so a
 * revocation always dominates every rotation that read an older value. The
 * caller is responsible for holding the environment row lock, which is why the
 * use case takes `TenancyLocks` and this function takes only the record.
 */
export function bumpAccessKeyRevocationVersion(
  environment: EnvironmentRecord,
  at: Date,
): EnvironmentRecord {
  return {
    ...environment,
    accessKeyRevocationVersion: environment.accessKeyRevocationVersion + 1,
    updatedAt: at,
  };
}
