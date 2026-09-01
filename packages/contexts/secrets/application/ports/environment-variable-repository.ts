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
}

export interface EnvironmentVariableRepository {
  findByKey(environmentId: EnvironmentId, key: string): Promise<Result<EnvironmentVariable | null>>;

  list(environmentId: EnvironmentId): Promise<Result<readonly EnvironmentVariable[]>>;

  /** Insert or update in one round trip, bumping `version`. */
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
