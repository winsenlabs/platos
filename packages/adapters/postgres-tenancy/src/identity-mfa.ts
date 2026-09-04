// `OperatorMfaStore` — the TOTP credential, its replay counter, and the
// recovery-code set.
//
// TWO OF THE FOUR CONDITIONAL WRITES IN THIS PORT LIVE HERE, and both are
// replay defences rather than optimisations.
//
// `advanceTotpCounter` moves `lastUsedCounter` forward only when it is null or
// strictly smaller. A TOTP code is valid for a whole 30-second step, so without
// the counter the same six digits work twice inside one window — which is the
// entire value of an intercepted code. Read-then-write would let two concurrent
// verifications of the SAME code both observe the old counter and both succeed.
//
// `consumeRecoveryCode` is `UPDATE ... WHERE consumedAt IS NULL` for the same
// reason with a longer window: a recovery code is valid until used, so a
// read-then-write race is a code that can be spent twice at leisure.
//
// `replaceRecoveryCodes` IS ATOMIC OR IT IS A LOCKOUT. It deletes the whole set
// and inserts the new one. Between those two statements the account has NO
// recovery codes at all, so if the process dies there the operator is locked out
// of their own second factor. It runs inside `transactions.atomic`, which joins
// the caller's transaction when there is one — enrolment writes the credential
// and the codes together and neither may survive the other.

import type {
  RecoveryCodeRecord,
  TokenHash,
  TotpCredential,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import type { OperatorMfaStore } from "@platos/context-identity-access/application/ports/index.js";

import { requireDigest, requireTotpShape } from "./identity-guards.js";
import { toRecoveryCodeRecord, toTotpCredential } from "./identity-rows.js";
import type { TenancyTransactions } from "./transaction.js";

const TOTP_COLUMNS = {
  userId: true,
  encryptedSecret: true,
  enabledAt: true,
  lastUsedCounter: true,
  pendingEncryptedSecret: true,
  pendingExpiresAt: true,
} as const;

const RECOVERY_COLUMNS = { userId: true, codeHash: true, consumedAt: true } as const;

export function createOperatorMfaStore(transactions: TenancyTransactions): OperatorMfaStore {
  return {
    async findTotp(userId: UserId): Promise<TotpCredential | null> {
      const row = await transactions
        .reader()
        .operatorMfaTotp.findUnique({ where: { userId }, select: TOTP_COLUMNS });
      return row === null ? null : toTotpCredential(row);
    },

    async saveTotp(credential: TotpCredential): Promise<void> {
      requireTotpShape(credential);
      const mutable = {
        encryptedSecret: credential.encryptedSecret,
        enabledAt: credential.enabledAt,
        lastUsedCounter: credential.lastUsedCounter,
        pendingEncryptedSecret: credential.pendingEncryptedSecret,
        pendingExpiresAt: credential.pendingExpiresAt,
      };
      await transactions.reader().operatorMfaTotp.upsert({
        where: { userId: credential.userId },
        create: { userId: credential.userId, ...mutable },
        update: mutable,
      });
    },

    async deleteTotp(userId: UserId): Promise<void> {
      // `deleteMany`, not `delete`. Disabling a second factor that was never
      // enrolled is not an error — the caller asked for the row to be gone and
      // it is gone — and `delete` on a missing row raises.
      await transactions.reader().operatorMfaTotp.deleteMany({ where: { userId } });
    },

    async advanceTotpCounter(userId: UserId, counter: bigint): Promise<boolean> {
      const result = await transactions.reader().operatorMfaTotp.updateMany({
        where: { userId, OR: [{ lastUsedCounter: null }, { lastUsedCounter: { lt: counter } }] },
        data: { lastUsedCounter: counter },
      });
      return result.count === 1;
    },

    async findRecoveryCode(
      userId: UserId,
      codeHash: TokenHash,
    ): Promise<RecoveryCodeRecord | null> {
      const row = await transactions.reader().operatorMfaRecoveryCode.findUnique({
        where: { userId_codeHash: { userId, codeHash } },
        select: RECOVERY_COLUMNS,
      });
      return row === null ? null : toRecoveryCodeRecord(row);
    },

    async consumeRecoveryCode(
      userId: UserId,
      codeHash: TokenHash,
      now: Date,
    ): Promise<boolean> {
      const result = await transactions.reader().operatorMfaRecoveryCode.updateMany({
        where: { userId, codeHash, consumedAt: null },
        data: { consumedAt: now },
      });
      return result.count === 1;
    },

    async replaceRecoveryCodes(
      userId: UserId,
      codeHashes: readonly TokenHash[],
    ): Promise<void> {
      for (const codeHash of codeHashes) {
        requireDigest("OperatorMfaRecoveryCode.codeHash", codeHash);
      }
      await transactions.atomic(async (client) => {
        await client.operatorMfaRecoveryCode.deleteMany({ where: { userId } });
        if (codeHashes.length === 0) return;
        // `createMany`, so the whole set is ONE statement rather than nine.
        // The count is fixed at nine in the extraction source, but the port
        // takes a list and a per-row insert would make the cost of enrolment a
        // function of a number this store does not choose.
        await client.operatorMfaRecoveryCode.createMany({
          data: codeHashes.map((codeHash) => ({ userId, codeHash })),
        });
      });
    },
  };
}
