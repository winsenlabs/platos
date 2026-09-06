// The driven port over EnvironmentVariable, the fourth sole-writer row.
//
// Separate from `SecretsRepository` so the two aggregates keep separate
// vocabularies, and so a composition root may back them with different stores
// without either port growing a conditional.

import type { EnvironmentId, Result, TransactionScope } from "@platos/kernel";

import type { CredentialId, EnvironmentVariableId } from "../../domain/ids.js";
import type {
  EnvironmentVariable,
  EnvironmentVariableKind,
} from "../../domain/environment-variable.js";

export interface EnvironmentVariableUpsert {
  readonly id: EnvironmentVariableId;
  readonly environmentId: EnvironmentId;
  readonly key: string;
  readonly kind: EnvironmentVariableKind;
  /** Null for SECRET. The invariant is the port's, not the caller's discipline. */
  readonly value: string | null;
  readonly credentialId: CredentialId | null;
  readonly lastUpdatedBy: string | null;
  readonly at: Date;
  /**
   * The `version` this write was decided from, or null to INSERT a new row.
   *
   * WIN-258 T7, and REQUIRED rather than optional on purpose. Every caller of
   * this port reads the row first — that is what `findByKey` is for — so every
   * caller already holds the value, and an optional field would let the one
   * caller that forgot it silently keep the lost update this fence exists to
   * close. Two concurrent writers on one key both read version N, both write,
   * and PostgreSQL applies both in turn and reports success to both; the first
   * one's value is gone and it was told it had been stored. Reproduced against a
   * real PostgreSQL, not reasoned about.
   *
   * A number means "update the row that is still at this version"; the store
   * answers `ENVIRONMENT_VARIABLE_VERSION_CONFLICT` when no such row is there.
   * Null means "there was no row"; the store answers the same conflict when one
   * has appeared since, because a concurrent INSERT is the same lost update
   * wearing the other shape.
   */
  readonly expectedVersion: number | null;
}

export interface EnvironmentVariableRepository {
  findByKey(environmentId: EnvironmentId, key: string): Promise<Result<EnvironmentVariable | null>>;

  list(environmentId: EnvironmentId): Promise<Result<readonly EnvironmentVariable[]>>;

  /**
   * Insert or update in one round trip, bumping `version`.
   *
   * FENCED on `input.expectedVersion`. The bump itself is not the fence and
   * never was: a monotonic `version` tells a later reader that the row changed,
   * and tells the writer that lost absolutely nothing.
   */
  upsert(
    input: EnvironmentVariableUpsert,
    transaction: TransactionScope,
  ): Promise<Result<EnvironmentVariable>>;

  remove(
    id: EnvironmentVariableId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  /**
   * How many variables still point at a credential. A credential that nothing
   * references is revoked, which is what stops the vault filling with orphans.
   */
  countReferences(credentialId: CredentialId): Promise<Result<number>>;
}
