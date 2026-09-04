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
      // Keyed on (userId, provider), NOT on (provider, subject), and the two
      // are different upserts. The schema carries BOTH unique indexes: a user
      // has at most one identity per provider, and a provider subject belongs
      // to at most one user. Upserting on the subject would let a user
      // accumulate a second GitHub identity when the provider re-issued their
      // subject; upserting on (userId, provider) rebinds the existing row,
      // which is what the extraction source does.
      await transactions.reader().operatorIdentity.upsert({
        where: {
          userId_provider: { userId: identity.userId, provider: identity.provider },
        },
        create: {
          userId: identity.userId,
          provider: identity.provider,
          subject: identity.subject,
          providerEmail: identity.providerEmail,
        },
        update: { subject: identity.subject, providerEmail: identity.providerEmail },
      });
    },
  };
}
