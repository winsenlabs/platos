// Use cases of the `tenancy` context.
//
// May import this context's `domain/` and `application/ports/`, this context's
// `contracts/`, and the published `contracts/` of the one peer ADR M0.3 §1
// grants it (`identity-access`). Never an adapter, never a framework, never a
// vendor SDK.

// WHY THE FIXTURES ARE PUBLISHED FROM HERE (WIN-257 T2). `apps/core-api` now
// composes this context, and the composition root's own suite has to prove the
// wiring REFUSES — a cross-tenant request, an archived ancestor, an environment
// that does not exist. It can only do that against a bundle that behaves like
// the real stores. `./testing/` is that bundle: it already ships in the package
// as the conformance fixture this context publishes for
// `packages/adapters/postgres-tenancy`, so re-exporting it hands the composition
// root the same doubles the adapter will be held to rather than a second set of
// fakes written in `apps/` that could drift from them.

export * from "./ports/index.js";
export * from "./dependencies.js";
export * from "./authorize-environment-operator.js";
export * from "./change-membership-role.js";
export * from "./invitations.js";
export * from "./add-project-member.js";
export * from "./create-organization.js";
export * from "./create-project.js";
export * from "./operator-read-models.js";
export * from "./archive-tenant.js";
export * from "./revoke-access-key-generation.js";
export * from "./tenancy-service.js";
export * from "./testing/fakes.js";
export * from "./testing/in-memory-repository.js";
export * from "./testing/tenant-fixture.js";

import type { IdentityAccessContract } from "@platos/context-identity-access";

import type { TenancyContract } from "../contracts/index.js";
import type { TenancyDependencies } from "./dependencies.js";
import type { TenancyRepository } from "./ports/index.js";

/**
 * The wiring shape `apps/core-api` builds at the composition root: the driven
 * ports going in, the driving contract coming out.
 *
 * Retained under its generated name so no sibling placeholder breaks.
 */
export interface TenancyUseCases {
  readonly repository: TenancyRepository;
  readonly dependencies: TenancyDependencies;
  readonly contract: TenancyContract;
  /**
   * The one cross-context edge ADR M0.3 §1 grants tenancy
   * (`tenancy -> identity-access`), held as the published contract type and
   * NOTHING else — this file is the only place in the context that names it.
   *
   * It is deliberately opaque. identity-access's contract is being written in
   * the same milestone, so tenancy commits to the NAME and to the DIRECTION of
   * the edge without coupling to a shape that is still moving. The one question
   * tenancy actually needs answered today — the email on a `User` row — is
   * asked through the narrow `OperatorDirectory` port instead, which the
   * composition root satisfies from this contract. When identity-access
   * stabilises, `OperatorDirectory` collapses into it and this handle starts
   * being called rather than merely held.
   */
  readonly identityAccess: IdentityAccessContract;
}
