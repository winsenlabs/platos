// The `IdentityAccessRepository` composite: ten stores over twenty-three rows.
//
// It is assembled from the modules beside it rather than written as one object,
// for the reason the port's own header gives: the store boundaries ARE the
// ownership boundaries, so a reviewer can hold this file next to
// `scripts/arch/table-ownership.mjs` and check them off. The ADR M0.3 §6 line
// budget makes the same split mandatory, and the two agree.
//
// EVERY STORE SHARES ONE `TenancyTransactions`, which is what makes the whole
// composite one connection. A use case that reads a session, writes an audit row
// and revokes a sibling session inside `UnitOfWork.run` gets one transaction
// across all three, and a read between two of those writes sees the writes —
// because the ambient frame in `./transaction.ts` is shared by every store here
// and by the tenancy repository in the same package.

import type { IdentityAccessRepository } from "@platos/context-identity-access/application/ports/index.js";

import { createAccessKeyStore } from "./identity-access-keys.js";
import { createBearerCredentialStore } from "./identity-bearer.js";
import { createEndUserStore, createImpersonationAuditStore } from "./identity-end-users.js";
import { createOperatorMfaStore } from "./identity-mfa.js";
import { createOAuthStore } from "./identity-oauth.js";
import { createMagicLinkStore, createOperatorSessionStore } from "./identity-sessions.js";
import { createOperatorIdentityStore, createUserStore } from "./identity-users.js";
import type { TenancyTransactions } from "./transaction.js";

export function createIdentityAccessRepository(
  transactions: TenancyTransactions,
): IdentityAccessRepository {
  return {
    users: createUserStore(transactions),
    operatorIdentities: createOperatorIdentityStore(transactions),
    operatorSessions: createOperatorSessionStore(transactions),
    magicLinks: createMagicLinkStore(transactions),
    mfa: createOperatorMfaStore(transactions),
    accessKeys: createAccessKeyStore(transactions),
    oauth: createOAuthStore(transactions),
    bearerCredentials: createBearerCredentialStore(transactions),
    endUsers: createEndUserStore(transactions),
    impersonationAudit: createImpersonationAuditStore(transactions),
  };
}
