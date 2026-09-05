// `OperatorDirectory` and `OperatorSessionRevoker` — tenancy's two edges into
// identity-access, satisfied THROUGH identity-access's contract rather than
// through its tables.
//
// WIN-257 REPORTED THIS AS OPEN and it is the point of tranche 3. Both ports
// were being satisfied from a bundle an install supplied, because when they
// were written identity-access had no store to satisfy them from: ADR M0.3 §4
// declared twelve adapter bindings and none of them was an identity store, so
// `apps/core-api/src/app.module.ts` says in its own header that neither context
// can be built from `adapters` and an install must hand over each bundle
// itself. Tranche 2 built `IdentityAccessRepository` in this directory, so the
// question WIN-257 could only report can now be answered.
//
// THE NARROW PEER PORT, AND WHY IT IS NOT A WHOLE-CONTRACT DOUBLE. Each factory
// below takes a `Pick<>` of ONE identity-access store — one method each — rather
// than the ten-store `IdentityAccessRepository`. That is deliberate three times
// over. It is the smallest surface that answers tenancy's question, so a reader
// can see exactly which identity-access rows tenancy can reach. It names
// identity-access's OWN published port type, so the two cannot drift: a change
// to `UserStore.findById` is a compile error here rather than a silent
// divergence. And it is not a double at all — the object handed in at assembly
// is the REAL store from `createIdentityAccessRepository`, over the same
// connection and inside the same transaction, which is what a whole-contract
// stand-in could never be. A stand-in for the whole contract has broken
// `build:v1` three times in this project; there is no stand-in here.
//
// WHAT DOES NOT CROSS. `UserStore.findById` returns `OperatorUserRecord`, which
// carries `platformOperator` — the flag that permits impersonation. Tenancy's
// `OperatorAccount` has three fields and that is not one of them, so the
// projection below DROPS it. An adapter that spread the record through would
// have published identity-access's impersonation rule into a context that has
// no business with it, and nothing would have failed.

import type {
  OperatorSessionStore,
  UserStore,
} from "@platos/context-identity-access/application/ports/index.js";
import type {
  OperatorAccount,
  OperatorDirectory,
  OperatorSessionRevoker,
  SessionRevocationOrder,
  TransactionScope,
  UserId,
} from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyTransactions } from "./transaction.js";

/**
 * The one question tenancy asks identity-access about an account.
 *
 * `Pick` of identity-access's published `UserStore`, so this alias cannot say
 * anything that store does not.
 */
export type OperatorAccountReader = Pick<UserStore, "findById">;

/** The one order tenancy sends identity-access about a session. */
export type OperatorSessionRevocationWriter = Pick<OperatorSessionStore, "revokeAllForUser">;

export function createOperatorDirectory(users: OperatorAccountReader): OperatorDirectory {
  return {
    async findAccount(userId: UserId): Promise<OperatorAccount | null> {
      const account = await users.findById(userId);
      if (account === null) return null;
      // Field by field, not a spread. See the header: `platformOperator` is on
      // the record this returns and must not be on the one tenancy receives.
      return {
        userId: account.userId,
        email: account.email,
        disabledAt: account.disabledAt,
      };
    },
  };
}

export function createOperatorSessionRevoker(
  transactions: TenancyTransactions,
  sessions: OperatorSessionRevocationWriter,
): OperatorSessionRevoker {
  return {
    async revoke(order: SessionRevocationOrder, transaction: TransactionScope): Promise<number> {
      // THE THREE REFUSALS FIRST, AND THE CLIENT DELIBERATELY DISCARDED.
      //
      // The write itself goes through identity-access's store, which resolves
      // its own client from the ambient frame; what tenancy's port adds on top
      // is the promise that the order runs inside the caller's NAMED
      // transaction. `writer(scope)` is the only thing that checks that, and
      // without this line a revocation handed a foreign or finished scope would
      // still commit — on whichever transaction happened to be ambient — while
      // the membership write it accompanies rolled back. The value is unused
      // because the store, not this port, issues the statement.
      transactions.writer(transaction);

      // `revokeAllForUser` matches BOTH `userId` and `impersonatedUserId`, which
      // is the half of the database rule an implementation is most likely to
      // forget; `order.includeImpersonatedSessions` is `true` by construction in
      // the domain and is named there for exactly that reason. Calling
      // identity-access's store rather than re-deriving the filter here is what
      // keeps the two from disagreeing: there is one OR clause in this package,
      // not two.
      return sessions.revokeAllForUser(order.userId, order.revokedAt);
    },
  };
}
