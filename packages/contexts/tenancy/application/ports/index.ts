// Driven ports of the `tenancy` context.
//
// Implemented by `packages/adapters/*` and wired in `apps/core-api`. Never
// imported by `domain/` — the arrows point inward, and a port is an
// application-layer concept because it is a use case that decides it needs one.
//
// `TenancyRepository` is the load-bearing name: `packages/adapters/postgres-tenancy`
// imports it from `@platos/context-tenancy/application/ports/index.js`, which is
// the second of this package's two published entry points.

export type { TenancyRepository, OrganizationMembershipUpsert } from "./repository.js";
export type { TenancyLocks } from "./locks.js";
export type { OperatorSessionRevoker } from "./session-revoker.js";
export type { EnvironmentAccessKeyRevocationCounter } from "./access-key-revocation.js";
export type { InvitationTokenIssuer, MintedInvitationToken } from "./invitation-token.js";
export type { OperatorDirectory, OperatorAccount } from "./operator-directory.js";
