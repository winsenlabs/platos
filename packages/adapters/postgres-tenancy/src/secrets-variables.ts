// `EnvironmentVariable` — the fourth row `secrets` is sole writer of.
//
// THE UPSERT KEYS ON `[environmentId, key]`, AND THE DOUBLE KEYS ON `id`. That
// is the sharpest divergence this tranche found, and it is the double that is
// wrong. `inMemorySecretsStore.upsert` does `tables.variables.get(input.id)`, so
// a caller handing a FRESH id for a key that already exists gets a SECOND row in
// memory and SQLSTATE 23505 from `EnvironmentVariable_environmentId_key_key` in
// PostgreSQL. The port's own sentence — "insert or update in one round trip" —
// is a statement about the store's uniqueness, and the store's uniqueness is the
// pair. `setEnvironmentVariable` never notices, because it reads the row first
// and reuses `existing.value.id`; every other caller of the port would.
//
// TWO COLUMNS ARE FROZEN ON UPDATE. `EnvironmentVariable_owner_immutable` fires
// BEFORE UPDATE over `environmentId` and `key`, so the conflict branch below
// writes neither — which is also why it cannot be written as "set every column
// the caller sent".
//
// AND THE CREDENTIAL IS CHECKED BY A RULE, NOT BY A FOREIGN KEY.
// `enforce_win124_credential_kind` fires BEFORE INSERT OR UPDATE and demands
// that a named credential be in the SAME environment, of kind
// `SECRET_REFERENCE`, NOT revoked, and already pointing at an active secret
// version. The foreign key alone would have accepted a revoked credential, a
// `CHANNEL_SECRET`, and one with no envelope at all. Nothing in the port's types
// says any of this, nothing in the double checks it, and it is the reason
// `setEnvironmentVariable` seals the credential BEFORE it writes the row rather
// than after.

import type {
  CredentialId,
  EnvironmentId,
  EnvironmentVariable,
  EnvironmentVariableId,
  EnvironmentVariableRepository,
  EnvironmentVariableUpsert,
  Result,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";
import { ok } from "@platos/context-secrets/application/ports/index.js";

import {
  requireInstant,
  requireUuid,
  requireUuidOrNull,
  requireVariableKey,
  requireVariableShape,
} from "./secrets-guards.js";
import type { VariableRow } from "./secrets-rows.js";
import { VARIABLE_COLUMNS, readVariable } from "./secrets-rows.js";
import type { TenancyTransactions } from "./transaction.js";

export function createEnvironmentVariableStore(
  transactions: TenancyTransactions,
): EnvironmentVariableRepository {
  return {
    async findByKey(
      environmentId: EnvironmentId,
      key: string,
    ): Promise<Result<EnvironmentVariable | null>> {
      // THROUGH `reader()`, WHICH PREFERS THE OPEN TRANSACTION, and that is
      // load-bearing rather than incidental. `setEnvironmentVariable` calls this
      // as the FIRST statement inside its `UnitOfWork.run`, and its whole
      // decision — reuse this row's id and its backing credential, or mint new
      // ones — hangs off the answer. On the pool it would not see a row the same
      // transaction had just written.
      const row = (await transactions.reader().environmentVariable.findUnique({
        where: { environmentId_key: { environmentId, key } },
        select: VARIABLE_COLUMNS,
      })) as VariableRow | null;
      return ok(row === null ? null : readVariable(row));
    },

    async list(environmentId: EnvironmentId): Promise<Result<readonly EnvironmentVariable[]>> {
      const rows = (await transactions.reader().environmentVariable.findMany({
        where: { environmentId },
        orderBy: { key: "asc" },
        select: VARIABLE_COLUMNS,
      })) as readonly VariableRow[];
      return ok(rows.map(readVariable));
    },

    async upsert(
      input: EnvironmentVariableUpsert,
      transaction: TransactionScope,
    ): Promise<Result<EnvironmentVariable>> {
      const key = requireVariableKey(input.key);
      const credentialId = requireUuidOrNull("EnvironmentVariable.credentialId", input.credentialId);
      requireVariableShape(input.kind, input.value, credentialId);
      const at = requireInstant("EnvironmentVariable.updatedAt", input.at);
      const environmentId = requireUuid("EnvironmentVariable.environmentId", input.environmentId);

      const row = (await transactions.writer(transaction).environmentVariable.upsert({
        where: { environmentId_key: { environmentId, key } },
        create: {
          id: requireUuid("EnvironmentVariable.id", input.id),
          environmentId,
          key,
          kind: input.kind,
          value: input.value,
          credentialId,
          // The column's own default is 1 and the double's first write produces
          // 1. Writing it explicitly is what makes the two agree by construction
          // rather than by two defaults happening to match.
          version: 1,
          lastUpdatedBy: input.lastUpdatedBy,
          createdAt: at,
          updatedAt: at,
        },
        update: {
          kind: input.kind,
          value: input.value,
          credentialId,
          // `increment`, not `existing.version + 1`. A read-then-write would lose
          // a concurrent bump, and `version` is the field a stale reader uses to
          // learn it is stale — a version that silently repeats is worse than no
          // version at all.
          version: { increment: 1 },
          lastUpdatedBy: input.lastUpdatedBy,
          updatedAt: at,
        },
        select: VARIABLE_COLUMNS,
      })) as VariableRow;
      return ok(readVariable(row));
    },

    async remove(
      id: EnvironmentVariableId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      // `deleteMany`, so a missing row is a COUNT of zero rather than P2025. The
      // port answers `Result<boolean>` and the double answers `Map.delete`'s
      // boolean, so a store that raised on an absent row would turn an idempotent
      // delete into a poisoned transaction.
      const removed = await transactions.writer(transaction).environmentVariable.deleteMany({
        where: { id: requireUuid("EnvironmentVariable.id", id) },
      });
      return ok(removed.count > 0);
    },

    async countReferences(credentialId: CredentialId): Promise<Result<number>> {
      // THE OTHER READ THAT MUST JOIN THE OPEN TRANSACTION.
      // `revokeIfUnreferenced` calls this immediately AFTER the upsert that
      // dropped the last reference, and revokes the credential when the answer is
      // zero. Answered from the pool it would still see the old row, count one,
      // and leave live readable material behind a variable nothing points at.
      const count = await transactions.reader().environmentVariable.count({
        where: { credentialId: requireUuid("EnvironmentVariable.credentialId", credentialId) },
      });
      return ok(count);
    },
  };
}
