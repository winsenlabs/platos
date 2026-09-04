// The two ways a caller reaches this context, and the one place both are
// checked.
//
// `tools` is the first adopted context with BOTH an operator surface and a
// public one, and they are authorized by different peers on purpose:
//
//   AN OPERATOR configuring the matrix — registering tools, switching one off,
//   exposing one on the inbound surface — presents a TENANCY grant. "May this
//   operator manage this environment's tools" is an RBAC question about the
//   tenant tree, and tenancy owns it.
//
//   A THIRD PARTY calling the hosted MCP surface presents a BEARER credential.
//   "Is this token real, unrevoked, and addressed to this scope" is an identity
//   question, and identity-access owns it.
//
// THE SECOND ONE IS ADR M0.3 §3's `auth -> tool-gateway` FIX, IN CODE. The
// ground truth has `auth.service.ts` importing `ToolRegistryService` and
// `auth.module.ts` importing `ToolGatewayModule` so that tool/scope validation
// could happen at login. §3 records the destination as a PHYSICAL DELETE of
// both imports, with the validation moving to EXECUTION TIME inside `tools`.
// That is what `verifyMcpCaller` below is: the check that used to run in auth,
// running here, at the moment of the call, asking identity-access one way. The
// `identity-isolation` rule in §5.1(g) locks the reverse edge permanently, so
// this cannot drift back.
//
// EXECUTION-TIME IS STRICTLY STRONGER THAN LOGIN-TIME AND THAT IS THE POINT.
// A token validated at login carries whatever the matrix said then; a token
// validated at the call carries what it says now. Revoking an entity's exposure
// took effect on the next login before, and takes effect on the next call now.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";
import type { PrincipalAuthorizationView } from "@platos/context-identity-access";
import type {
  EnvironmentAccess,
  EnvironmentOperatorAuthorization as TenancyOperatorGrant,
} from "@platos/context-tenancy";

import { scopeMismatch } from "../domain/index.js";
import type { ToolsDependencies } from "./dependencies.js";

export type { PrincipalAuthorizationView, TenancyOperatorGrant };

/**
 * Verify an operator grant, by ASKING TENANCY.
 *
 * Through `TenancyContract.verifyAuthorization` rather than the pure predicate
 * this package could also import, for the reason `providers` gives on the same
 * seam: an authorization is genuine only if tenancy's own private mint register
 * holds it, and a grant arriving as `unknown` from a transport is exactly the
 * "crossed a boundary where its type was erased" case that method exists for.
 *
 * IT IS MODULE-PRIVATE. See `withOperator` below for why.
 */
function verifyOperator(
  dependencies: ToolsDependencies,
  authorization: unknown,
): Result<TenancyOperatorGrant> {
  return dependencies.tenancy.verifyAuthorization(authorization);
}

/**
 * Verify an operator grant and run the use case with it. ONE GUARD, NOT FOURTEEN.
 *
 * Every operator-authorized use case in this context used to reach its grant
 * through the same two hand-written lines — ask tenancy, then
 * `if (!granted.ok) return err(granted.error);` — copied to fourteen call
 * sites. Eleven of the fourteen could have their copy deleted with the whole
 * suite green, which is what a guard that is cheap to copy and expensive to
 * prove decays into.
 *
 * THE GRANT IS NOW UNREACHABLE WITHOUT THE CHECK. `verifyOperator` is
 * module-private and this is the only export that hands out a
 * `TenancyOperatorGrant`, so a use case added later cannot obtain one without
 * the refusal having already run. It cannot forget the guard; it can only
 * decline to ask for a grant, and a use case holding no grant holds no scope to
 * work in.
 *
 * `requireAccess` IS DELIBERATELY NOT FOLDED IN. "Did tenancy mint this" and
 * "does it carry secret:mutate" are different questions and only some callers
 * ask the second. Taking it as an argument would turn the mutating gate from a
 * visible line at the call site into a parameter value, which is the harder
 * thing to notice missing.
 */
export async function withOperator<Value>(
  dependencies: ToolsDependencies,
  authorization: unknown,
  run: (grant: TenancyOperatorGrant) => Promise<Result<Value>>,
): Promise<Result<Value>> {
  const granted = verifyOperator(dependencies, authorization);
  if (!granted.ok) return err(granted.error);
  return run(granted.value);
}

/** `metadata` cannot mutate. Asking for more than the grant carries fails. */
export function requireAccess(
  grant: TenancyOperatorGrant,
  access: EnvironmentAccess,
): Result<TenancyOperatorGrant> {
  if (access === "secret:mutate" && grant.access !== "secret:mutate") {
    return err(scopeMismatch("secret:mutate", grant.access));
  }
  return ok(grant);
}

/**
 * Authenticate an inbound MCP caller, at the moment of the call.
 *
 * The scope is passed to `authenticateBearer` rather than compared afterwards,
 * because that method's own contract note says it is what denies a credential
 * ACROSS scopes. Handing it null and checking later would move the cross-scope
 * decision out of the context that owns it and into this one, where it would be
 * one forgotten call site away from not happening.
 */
export async function verifyMcpCaller(
  dependencies: ToolsDependencies,
  presentedToken: string | null,
  scope: EnvironmentScope,
): Promise<Result<PrincipalAuthorizationView>> {
  return dependencies.identityAccess.authenticateBearer({
    presentedToken,
    requestedScope: scope,
    requiredPermission: MCP_TOOLS_PERMISSION,
  });
}

/**
 * The permission an inbound MCP caller must hold to reach any tool.
 *
 * A COARSE gate, deliberately. It says "this credential is for the tool
 * surface"; it does not say which tools, because that is `EntityToolPolicy`'s
 * scope labels and identity modes, evaluated per tool in
 * `domain/entity-policy.ts`. Two gates, one coarse and one fine, is what lets
 * a token be revoked from the whole surface without editing every policy row.
 */
export const MCP_TOOLS_PERMISSION = "mcp:tools";
