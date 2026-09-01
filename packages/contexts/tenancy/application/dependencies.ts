// Everything a tenancy use case is allowed to reach.
//
// Time and identity are PORTS, not ambient functions. No `new Date()` and no
// `randomUUID()` appears anywhere in this package: a use case that expires an
// invitation, stamps a deactivation or mints a membership id is exercisable at
// any instant with any id, which is what makes the negative controls below
// deterministic rather than flaky.
//
// Every use-case factory takes a `Pick<>` of this type rather than the whole
// thing, so its dependency list is its signature: a use case that cannot revoke
// a session cannot be handed a session revoker by accident.

// The one cross-context edge ADR M0.3 §1 grants tenancy
// (`tenancy -> identity-access`) is NOT declared here. It is held on
// `TenancyUseCases` in `application/index.ts`, the composition-root wiring
// shape, because no use case calls it: the single question tenancy needs
// identity-access to answer today — the email on a `User` row — is asked
// through the narrow `OperatorDirectory` port instead (reader-port inversion,
// ADR M0.3 §2). Keeping the edge at the wiring seam rather than on every use
// case's dependency bag is what lets that stay true.

import type { Clock, IdGenerator, Logger, UnitOfWork } from "@platos/kernel";

import type {
  EnvironmentAccessKeyRevocationCounter,
  InvitationTokenIssuer,
  OperatorDirectory,
  OperatorSessionRevoker,
  TenancyLocks,
  TenancyRepository,
} from "./ports/index.js";

export interface TenancyDependencies {
  readonly repository: TenancyRepository;
  readonly locks: TenancyLocks;
  readonly sessionRevoker: OperatorSessionRevoker;
  readonly accessKeyRevocation: EnvironmentAccessKeyRevocationCounter;
  readonly invitationTokens: InvitationTokenIssuer;
  readonly operators: OperatorDirectory;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly logger: Logger;
}
