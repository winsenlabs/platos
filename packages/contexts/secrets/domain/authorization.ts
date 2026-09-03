// The authorization this context REQUIRES, and why it cannot be forged.
//
// ADR M0.3 §1 row 3 gives `secrets` an import allow-list of exactly `kernel`. It
// may not import identity-access, so it cannot ask who anybody is. What it can do
// is state the shape of the grant it will accept and refuse everything else. The
// composition root, which does hold identity-access, authenticates first and then
// mints one of these.
//
// UNFORGEABILITY IS A REAL CONTROL, NOT CEREMONY. The extraction source
// (internal-packages/tenancy-database/src/auth.ts) tags every authorization with
// a module-private `unique symbol` precisely so that an object literal cannot
// stand in for one. That property is preserved and strengthened here:
//
//   * COMPILE TIME — a phantom brand, so a structurally identical literal is a
//     type error at every call site without a cast.
//   * RUN TIME — a module-private WeakSet of the exact objects this module minted
//     and froze. Identity, not shape. A JSON body parsed off the wire is not in
//     the set. Nor is `{ ...realAuthorization }`, which under the symbol-property
//     approach WOULD have copied the brand across and been accepted.
//
// The consequence worth stating plainly: no value that entered the process as
// data can ever be an authorization. Only code that called a mint function below,
// after doing the work that function demands, holds one.

import type { EnvironmentId, OrganizationId, ProjectId } from "@platos/kernel";

import type { ActorId } from "./ids.js";

declare const secretsAuthorization: unique symbol;

type Unforgeable<Shape> = Shape & { readonly [secretsAuthorization]: "secrets.authorization" };

/** Every authorization is pinned to one environment in the tenancy tree. */
interface EnvironmentAncestry {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
}

/** What an operator grant may carry. `metadata` cannot mutate anything. */
export type EnvironmentAuthorizationAccess = "metadata" | "secret:mutate";

export type EnvironmentOperatorAuthorization = Unforgeable<
  EnvironmentAncestry & {
    readonly principalType: "operator";
    readonly tier: "OPERATOR";
    readonly access: EnvironmentAuthorizationAccess;
    readonly actorUserId: ActorId;
    /** Differs from `actorUserId` under impersonation; audit keeps both. */
    readonly effectiveUserId: ActorId;
  }
>;

export type EnvironmentRuntimeAuthorization = Unforgeable<
  EnvironmentAncestry & {
    readonly principalType: "runtime";
    readonly tier: "RUNTIME";
    readonly access: "secret:read";
    readonly actorId: ActorId;
  }
>;

export type EnvironmentServiceAuthorization = Unforgeable<
  EnvironmentAncestry & {
    readonly principalType: "service";
    readonly tier: "RUNTIME";
    readonly access: "secret:write";
    readonly actorId: ActorId;
  }
>;

/**
 * The installation-global grant that root key operations need.
 *
 * Purging retired envelopes and reporting root key usage cross every tenant, so
 * no environment-scoped grant can authorize them. This is a separate principal
 * type on purpose: widening an operator grant to reach them would have made every
 * environment operator an installation operator.
 */
export type RootKeyOperationsAuthorization = Unforgeable<{
  readonly principalType: "operations";
  readonly installationScope: "global";
  readonly actorId: ActorId;
}>;

export type EnvironmentAuthorization =
  | EnvironmentOperatorAuthorization
  | EnvironmentRuntimeAuthorization
  | EnvironmentServiceAuthorization;

/** Grants that may write secret material. */
export type SecretMutationAuthorization =
  | EnvironmentOperatorAuthorization
  | EnvironmentServiceAuthorization;

const minted = new WeakSet<object>();

function mint<Shape extends object>(shape: Shape): Unforgeable<Shape> {
  const frozen = Object.freeze(shape);
  minted.add(frozen);
  return frozen as Unforgeable<Shape>;
}

/** Identity check against the mint register. Shape is irrelevant here. */
export function isMintedAuthorization(value: unknown): boolean {
  return typeof value === "object" && value !== null && minted.has(value);
}

export function authorizeEnvironmentOperator(grant: {
  ancestry: EnvironmentAncestry;
  access: EnvironmentAuthorizationAccess;
  actorUserId: ActorId;
  effectiveUserId: ActorId;
}): EnvironmentOperatorAuthorization {
  return mint({
    ...grant.ancestry,
    principalType: "operator" as const,
    tier: "OPERATOR" as const,
    access: grant.access,
    actorUserId: grant.actorUserId,
    effectiveUserId: grant.effectiveUserId,
  });
}

export function authorizeEnvironmentRuntime(grant: {
  ancestry: EnvironmentAncestry;
  actorId: ActorId;
}): EnvironmentRuntimeAuthorization {
  return mint({
    ...grant.ancestry,
    principalType: "runtime" as const,
    tier: "RUNTIME" as const,
    access: "secret:read" as const,
    actorId: grant.actorId,
  });
}

export function authorizeEnvironmentService(grant: {
  ancestry: EnvironmentAncestry;
  actorId: ActorId;
}): EnvironmentServiceAuthorization {
  return mint({
    ...grant.ancestry,
    principalType: "service" as const,
    tier: "RUNTIME" as const,
    access: "secret:write" as const,
    actorId: grant.actorId,
  });
}

export function authorizeRootKeyOperations(grant: {
  actorId: ActorId;
}): RootKeyOperationsAuthorization {
  return mint({
    principalType: "operations" as const,
    installationScope: "global" as const,
    actorId: grant.actorId,
  });
}

/** The actor an audit row records, and the operator it was effectively done as. */
export function auditActor(authorization: EnvironmentAuthorization): {
  actorId: ActorId;
  effectiveUserId: ActorId | null;
} {
  if (authorization.principalType === "operator") {
    return { actorId: authorization.actorUserId, effectiveUserId: authorization.effectiveUserId };
  }
  return { actorId: authorization.actorId, effectiveUserId: null };
}

export function environmentOf(authorization: EnvironmentAuthorization): EnvironmentId {
  return authorization.environmentId;
}
