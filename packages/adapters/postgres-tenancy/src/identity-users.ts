// `UserStore` and `OperatorIdentityStore` — the two rows a login creates.
//
// They are one module because they are one use case: `completeOAuthLogin` in
// the extraction source upserts the User by address and then upserts the
// OperatorIdentity that proved it, and neither half means anything alone.
//
// `upsertByEmail` IS A GET-OR-CREATE AND ITS RACE IS REAL. Two concurrent first
// logins for the same address both find nothing and both insert; `User.email` is
// UNIQUE so one of them loses with SQLSTATE 23505. The loser re-reads rather
// than failing, because from the caller's point of view the account it asked for
// now exists and the identity of the transaction that created it is not
// something a login has any business caring about.

import type {
  EmailAddress,
  OperatorIdentityProvider,
  OperatorIdentityRecord,
  OperatorUserRecord,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import type {
  OperatorIdentityStore,
  UserStore,
} from "@platos/context-identity-access/application/ports/index.js";

import { isUniqueViolation } from "./client.js";
import { requireNormalisedEmail } from "./identity-guards.js";
import { toOperatorIdentityRecord, toUserRecord } from "./identity-rows.js";
import type { TenancyTransactions } from "./transaction.js";

const USER_COLUMNS = {
  id: true,
  email: true,
  platformOperator: true,
  disabledAt: true,
} as const;

const IDENTITY_COLUMNS = {
  userId: true,
  provider: true,
  subject: true,
  providerEmail: true,
} as const;

export function createUserStore(transactions: TenancyTransactions): UserStore {
  const findByEmail = async (address: EmailAddress): Promise<OperatorUserRecord | null> => {
    const row = await transactions
      .reader()
      .user.findUnique({ where: { email: address }, select: USER_COLUMNS });
    return row === null ? null : toUserRecord(row);
  };

  return {
    async findById(userId: UserId): Promise<OperatorUserRecord | null> {
      const row = await transactions
        .reader()
        .user.findUnique({ where: { id: userId }, select: USER_COLUMNS });
      return row === null ? null : toUserRecord(row);
    },

    findByEmail,

    async upsertByEmail(address: EmailAddress, newUserId: UserId): Promise<OperatorUserRecord> {
      requireNormalisedEmail("User.email", address);
      const existing = await findByEmail(address);
      if (existing !== null) return existing;
      try {
        const created = await transactions.reader().user.create({
          data: { id: newUserId, email: address },
          select: USER_COLUMNS,
        });
        return toUserRecord(created);
      } catch (error) {
        // The concurrent first login described above. Anything else is a real
        // failure and is rethrown, so a foreign-key or constraint defect is not
        // absorbed by a retry that then returns null.
        if (!isUniqueViolation(error)) throw error;
        const won = await findByEmail(address);
        if (won === null) throw error;
        return won;
      }
    },
  };
}

export function createOperatorIdentityStore(
  transactions: TenancyTransactions,
): OperatorIdentityStore {
  return {
    async findByProviderSubject(
      provider: OperatorIdentityProvider,
      subject: string,
    ): Promise<OperatorIdentityRecord | null> {
      const row = await transactions.reader().operatorIdentity.findUnique({
        where: { provider_subject: { provider, subject } },
        select: IDENTITY_COLUMNS,
      });
      return row === null ? null : toOperatorIdentityRecord(row);
    },

    async upsert(identity: OperatorIdentityRecord): Promise<void> {
      // KEYED ON (provider, subject), AND ONLY `providerEmail` IS UPDATED.
      // That is `completeOAuthLogin`'s upsert byte for byte, and the first
      // draft of this store had it keyed on (userId, provider) instead —
      // rebinding a user's existing row to a new subject, which is a DIFFERENT
      // operation. The differential against `PlatosAuthService` is what caught
      // it; both keys exist as unique indexes on the table, so nothing about
      // the schema alone says which one an upsert means.
      //
      // The consequence of matching the oracle is worth stating: a second
      // subject for a user who already has an identity with this provider is an
      // INSERT, and `OperatorIdentity_userId_provider_key` refuses it. That is
      // the oracle's behaviour, it is asserted in
      // `identity-constraints.integration.test.ts`, and the in-memory double —
      // which carries neither unique index — accepts it silently.
      await transactions.reader().operatorIdentity.upsert({
        where: {
          provider_subject: { provider: identity.provider, subject: identity.subject },
        },
        create: {
          userId: identity.userId,
          provider: identity.provider,
          subject: identity.subject,
          providerEmail: identity.providerEmail,
        },
        update: { providerEmail: identity.providerEmail },
      });
    },
  };
}
