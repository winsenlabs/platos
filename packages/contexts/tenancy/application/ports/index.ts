// Driven ports of the `tenancy` context.
//
// Implemented by `packages/adapters/*` and wired in `apps/core-api`. Never
// imported by `domain/` — the arrows point inward, and a port is an
// application-layer concept because it is a use case that decides it needs one.
//
// `TenancyRepository` is the load-bearing name: `packages/adapters/postgres-tenancy`
// imports it from `@platos/context-tenancy/application/ports/index.js`, which is
// the second of this package's two published entry points.
//
// WHY THIS FILE ALSO RE-EXPORTS RECORD AND IDENTIFIER TYPES. An adapter has to
// BUILD the records the port hands back, and its only workspace dependency is
// this package: ADR M0.3 §13 gives an adapter exactly one project edge, to the
// context that owns its port. Without the re-exports below the adapter would
// have to reach into `../../domain/`, which the boundary rules exist to stop, or
// take a second dependency on the kernel, which would change the V1 project
// graph. The precedent is `providers`, whose ports entry point re-exports
// `err`/`ok` for the same reason. Nothing new is published: every name below is
// already public from `../../domain/index.js` or from `@platos/kernel`.

export type { TenancyRepository, OrganizationMembershipUpsert } from "./repository.js";
export type { TenancyLocks } from "./locks.js";
export type { OperatorSessionRevoker } from "./session-revoker.js";
export type { EnvironmentAccessKeyRevocationCounter } from "./access-key-revocation.js";
export type { InvitationTokenIssuer, MintedInvitationToken } from "./invitation-token.js";
export type { OperatorDirectory, OperatorAccount } from "./operator-directory.js";

// --- what an implementation of the ports above needs in order to build a record

export { asIdentifier } from "@platos/kernel";
export type {
  Branded,
  EntityId,
  EnvironmentId,
  OrganizationId,
  ProjectId,
  TransactionId,
  TransactionScope,
  UnitOfWork,
} from "@platos/kernel";

export { OrganizationRole, PrincipalTier, ProjectRole } from "../../domain/index.js";
export { isOrganizationRole, isProjectRole } from "../../domain/index.js";
export type {
  EmailAddress,
  EntityRecord,
  EnvironmentAncestry,
  EnvironmentRecord,
  EnvironmentSessionId,
  EnvironmentSessionRecord,
  OperatorSessionId,
  OrganizationInvitationId,
  OrganizationInvitationRecord,
  OrganizationMembershipId,
  OrganizationMembershipRecord,
  OrganizationRecord,
  ProjectMembershipId,
  ProjectMembershipRecord,
  ProjectRecord,
  // WIN-258 T3. `OperatorSessionRevoker.revoke` takes a `SessionRevocationOrder`
  // and that type was declared in `domain/`, named on the port, and never
  // re-exported here — so the one parameter of the one method of that port was
  // unnameable by the only kind of package entitled to implement it. It is the
  // same defect tranche 2 found on `EndUserStore` in identity-access's ports
  // entry point, found the same way: by an implementation of the port failing
  // to compile.
  SessionRevocationOrder,
  Slug,
  TokenDigest,
  UserId,
} from "../../domain/index.js";
