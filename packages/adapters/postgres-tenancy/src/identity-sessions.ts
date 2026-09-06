// `OperatorSessionStore` and `MagicLinkStore` — the two credentials a browser
// login produces, and the conditional writes that make the second single-use.
//
// THE `save` METHODS ARE UPSERTS, NOT INSERTS. `OperatorSessionRecord` carries
// its own `sessionId`, minted by the use case from the kernel `IdGenerator`, and
// the port has no separate `create`/`update` pair. A use case that revokes a
// session builds the revoked record and saves it. So the write has to be an
// upsert keyed on the identifier the record already holds.
//
// `revokeAllForUser` COUNTS BOTH SIDES OF AN IMPERSONATION. A session belonging
// to the user and a session in which somebody is impersonating the user are both
// credentials that outlive a privilege change, and the extraction source's
// database-side rule on `OrganizationMembership` revokes both. Filtering on
// `userId` alone would leave the impersonating operator holding a live session
// over an account whose role just changed.

import type {
  MagicLinkTokenRecord,
  OperatorSessionId,
  OperatorSessionRecord,
  TokenHash,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import type {
  MagicLinkStore,
  OperatorSessionStore,
} from "@platos/context-identity-access/application/ports/index.js";

import { requireDigest, requireNormalisedEmail } from "./identity-guards.js";
import { toMagicLinkRecord, toOperatorSessionRecord } from "./identity-rows.js";
import type { TenancyTransactions } from "./transaction.js";

const SESSION_COLUMNS = {
  id: true,
  tokenHash: true,
  tier: true,
  userId: true,
  impersonatedUserId: true,
  parentSessionId: true,
  mfaVerifiedAt: true,
  expiresAt: true,
  revokedAt: true,
  lastSeenAt: true,
  createdAt: true,
} as const;

const MAGIC_LINK_COLUMNS = {
  tokenHash: true,
  email: true,
  expiresAt: true,
  consumedAt: true,
  createdAt: true,
} as const;

export function createOperatorSessionStore(
  transactions: TenancyTransactions,
): OperatorSessionStore {
  return {
    async findByTokenHash(tokenHash: TokenHash): Promise<OperatorSessionRecord | null> {
      const row = await transactions
        .reader()
        .operatorSession.findUnique({ where: { tokenHash }, select: SESSION_COLUMNS });
      return row === null ? null : toOperatorSessionRecord(row);
    },

    async findById(sessionId: OperatorSessionId): Promise<OperatorSessionRecord | null> {
      const row = await transactions
        .reader()
        .operatorSession.findUnique({ where: { id: sessionId }, select: SESSION_COLUMNS });
      return row === null ? null : toOperatorSessionRecord(row);
    },

    async save(session: OperatorSessionRecord): Promise<void> {
      requireDigest("OperatorSession.tokenHash", session.tokenHash);
      const mutable = {
        tokenHash: session.tokenHash,
        tier: session.tier,
        userId: session.userId,
        impersonatedUserId: session.impersonatedUserId,
        parentSessionId: session.parentSessionId,
        mfaVerifiedAt: session.mfaVerifiedAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        lastSeenAt: session.lastSeenAt,
      };
      await transactions.reader().operatorSession.upsert({
        where: { id: session.sessionId },
        // `createdAt` is written on INSERT and never on UPDATE. It is the one
        // column a save must not carry forward from the record it was handed:
        // a caller that read a row, changed a field and saved it back would
        // otherwise be able to move when the session began.
        create: { id: session.sessionId, createdAt: session.createdAt, ...mutable },
        update: mutable,
      });
    },

    async revokeAllForUser(
      userId: UserId,
      now: Date,
      exceptSessionId?: OperatorSessionId,
    ): Promise<number> {
      const result = await transactions.reader().operatorSession.updateMany({
        where: {
          OR: [{ userId }, { impersonatedUserId: userId }],
          revokedAt: null,
          ...(exceptSessionId === undefined ? {} : { id: { not: exceptSessionId } }),
        },
        data: { revokedAt: now },
      });
      return result.count;
    },
  };
}

export function createMagicLinkStore(transactions: TenancyTransactions): MagicLinkStore {
  return {
    async save(link: MagicLinkTokenRecord): Promise<void> {
      requireDigest("MagicLinkToken.tokenHash", link.tokenHash);
      requireNormalisedEmail("MagicLinkToken.email", link.email);
      await transactions.reader().magicLinkToken.create({
        data: {
          tokenHash: link.tokenHash,
          email: link.email,
          expiresAt: link.expiresAt,
          consumedAt: link.consumedAt,
          createdAt: link.createdAt,
        },
      });
    },

    async findByTokenHash(tokenHash: TokenHash): Promise<MagicLinkTokenRecord | null> {
      const row = await transactions
        .reader()
        .magicLinkToken.findUnique({ where: { tokenHash }, select: MAGIC_LINK_COLUMNS });
      return row === null ? null : toMagicLinkRecord(row);
    },

    async consume(tokenHash: TokenHash, now: Date): Promise<boolean> {
      // ONE STATEMENT, with the precondition in the WHERE clause and the row
      // count as the answer. Read-then-write here is a double-spend: two
      // concurrent clicks on the same mailed link would both read
      // `consumedAt: null`, both write, and both mint a session. `expiresAt`
      // is in the filter too, so an expired link cannot be consumed even by a
      // caller that skipped the domain check.
      const result = await transactions.reader().magicLinkToken.updateMany({
        where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      return result.count === 1;
    },
  };
}
