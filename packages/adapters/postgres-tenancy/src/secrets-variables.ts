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
// THE WRITE IS FENCED ON `version`, AND THAT IS WIN-258 T7's WHOLE CONTRIBUTION
// TO THIS FILE. The bump was already here and it was never a fence: `version:
// { increment: 1 }` tells a LATER reader the row moved and tells the writer that
// lost nothing at all. Two `setEnvironmentVariable` calls on one key both read
// version N, both write, and PostgreSQL — which serializes the two UPDATEs on
// the row lock and then applies both — answers success to both. The first
// caller's value is gone and it was told it had been stored. That was reproduced
// against a real container before the fence was written, and the same two
// concurrent transactions now end with one `ENVIRONMENT_VARIABLE_VERSION_CONFLICT`.
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
import {
  environmentVariableVersionConflict,
  err,
  ok,
} from "@platos/context-secrets/application/ports/index.js";

import { isRecordNotFound } from "./client.js";

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

      const writer = transactions.writer(transaction);

      // NO ROW WAS READ, SO THE FENCE IS THE UNIQUE INDEX ITSELF. Not `upsert`:
      // an upsert here would quietly turn "I am creating this" into "I am
      // overwriting whatever is there", which is the lost update in its other
      // shape — a caller that read no row and a caller that read version 7 would
      // both succeed and one of them would be writing over a value it never saw.
      // `EnvironmentVariable_environmentId_key_key` refuses the second one.
      //
      // AND IT IS `createManyAndReturn` WITH `skipDuplicates` RATHER THAN
      // `create` IN A `try`, WHICH IS THE OPPOSITE OF WHAT THIS PACKAGE DOES
      // EVERYWHERE ELSE. WIN-258 T7 put a caught SQLSTATE 23505 inside a real
      // interactive transaction and asked the connection one more question: it
      // answered SQLSTATE 25P02, "current transaction is aborted, commands
      // ignored until end of transaction block". PostgreSQL aborts a transaction
      // on a constraint violation and the client opens no savepoint around a
      // statement, so a store that CATCHES a violation and answers `Result` has
      // returned a value to a caller whose transaction is already dead — the
      // `err` is true and everything the caller does with it is not.
      // `channels-links.ts` documents the same fact from the other side and
      // deliberately reads nothing after its own catch.
      //
      // WORSE, THE COMMIT THEN REPORTS SUCCESS. PostgreSQL turns the COMMIT of an
      // aborted transaction into a ROLLBACK and answers `COMMIT`, so the caller
      // is told the whole block landed while every row in it was discarded —
      // measured in `transaction-boundaries.integration.test.ts`. A store that
      // wants to keep answering `Result` therefore has to avoid the violation,
      // not catch it.
      //
      // `skipDuplicates` emits `ON CONFLICT DO NOTHING`, so the conflict is an
      // EMPTY RESULT and no error is raised at all: one statement, the row back
      // when it was written, a usable transaction either way.
      if (input.expectedVersion === null) {
        const created = (await writer.environmentVariable.createManyAndReturn({
          data: [
            {
              id: requireUuid("EnvironmentVariable.id", input.id),
              environmentId,
              key,
              kind: input.kind,
              value: input.value,
              credentialId,
              // The column's own default is 1 and the double's first write
              // produces 1. Writing it explicitly is what makes the two agree by
              // construction rather than by two defaults happening to match.
              version: 1,
              lastUpdatedBy: input.lastUpdatedBy,
              createdAt: at,
              updatedAt: at,
            },
          ],
          skipDuplicates: true,
          select: VARIABLE_COLUMNS,
        })) as readonly VariableRow[];
        const row = created[0];
        if (row === undefined) return err(environmentVariableVersionConflict(null));
        return ok(readVariable(row));
      }

      // THE COMPARE-AND-SET. The version the caller read is in the WHERE clause,
      // beside the compound unique, so PostgreSQL evaluates the precondition and
      // the write as ONE statement and no window exists between them. `update`
      // rather than `updateMany` for two reasons: it returns the stored row, so
      // the answer needs no second statement, and it reports a miss as P2025
      // instead of as a count nobody is obliged to look at.
      //
      // `increment`, not `expectedVersion + 1`. The two are equal on the row this
      // WHERE clause can match, and writing the increment keeps the column's rule
      // — it only ever goes up — true in the statement rather than true by the
      // caller's arithmetic.
      try {
        const updated = (await writer.environmentVariable.update({
          where: {
            environmentId_key: { environmentId, key },
            version: input.expectedVersion,
          },
          data: {
            kind: input.kind,
            value: input.value,
            credentialId,
            version: { increment: 1 },
            lastUpdatedBy: input.lastUpdatedBy,
            updatedAt: at,
          },
          select: VARIABLE_COLUMNS,
        })) as VariableRow;
        return ok(readVariable(updated));
      } catch (error) {
        // MATCHED NO ROW. Either the row moved on — somebody else wrote between
        // this caller's read and this statement — or it was deleted. Both are the
        // same answer to this caller: what you read is not what is there, read
        // again. They are deliberately NOT distinguished, because a caller cannot
        // act on the difference and the retry is identical.
        if (isRecordNotFound(error)) {
          return err(environmentVariableVersionConflict(input.expectedVersion));
        }
        throw error;
      }
    },

    async remove(
      environmentId: EnvironmentId,
      id: EnvironmentVariableId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      // `deleteMany`, so a missing row is a COUNT of zero rather than P2025. The
      // port answers `Result<boolean>` and the double answers `Map.delete`'s
      // boolean, so a store that raised on an absent row would turn an idempotent
      // delete into a poisoned transaction.
      //
      // AND THE `environmentId` IS IN THE WHERE CLAUSE, not merely in the
      // signature. `id` is a bare uuid primary key, so without it this statement
      // reaches any tenant's row that a caller can name — WIN-258 T7 ran exactly
      // that against a real database and watched a second environment's variable
      // disappear.
      const removed = await transactions.writer(transaction).environmentVariable.deleteMany({
        where: {
          id: requireUuid("EnvironmentVariable.id", id),
          environmentId: requireUuid("EnvironmentVariable.environmentId", environmentId),
        },
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
