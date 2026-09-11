// HOW A V1 ROUTE LEARNS WHO IS CALLING, AND THE FOUR DIFFERENT ANSWERS IT GIVES
// WHEN IT CANNOT.
//
// This is the only authentication seam in the V1 REST surface. Every controller
// under `transports/` calls it and none of them repeats it, for the reason
// `error-taxonomy.mjs` states as the whole point of that gate: "two guards
// returning the same error code cannot be told apart". Five controllers each
// deciding for themselves what an absent cookie means would be five guards, and
// the first one written slightly differently would be the one an operator chases
// for a week.
//
// IT REACHES A PUBLISHED CONTRACT AND NOTHING ELSE. `identityAccess` and
// `tenancy` are read off `AppModule.contexts`; no store, no adapter, no Prisma.
// `scripts/arch/composition-root.mjs` (C8) refuses a transport that reads
// `app.adapters` at all, which is the mechanical half of the same rule.
//
// -----------------------------------------------------------------------------
// THE REFUSALS ARE THE CONTRACT'S, PASSED THROUGH UNTOUCHED
//
// The single most tempting thing to write here is `catch -> 401`. It would be
// wrong four times over, and `identity-access/domain/errors.ts` already mints the
// four answers this seam must not collapse:
//
//   UNAUTHENTICATED   401  no token, no such session, no such actor
//   SESSION_EXPIRED   401  a real session whose window has closed
//   SESSION_REVOKED   401  a real session somebody ended, or whose parent ended
//   MFA_REQUIRED      401  a real, live session that has not passed its second
//                          factor — the one refusal a client can actually act on
//
// and the two that arrive one layer further in, from `tenancy`:
//
//   TENANCY_ENVIRONMENT_FORBIDDEN  403  the four-gate RBAC decision said no, with
//                                       `details.gate` naming WHICH of the four
//   TENANCY_PROJECT_CREATION_FORBIDDEN 403 not a member of that organization
//
// A client told "401" learns nothing; a client told SESSION_EXPIRED refreshes,
// told MFA_REQUIRED prompts, and told SESSION_REVOKED signs the operator out. So
// `raise(result.error)` — the error value the context returned, unedited — is not
// laziness. It is the requirement.
//
// -----------------------------------------------------------------------------
// WHERE THE TOKEN COMES FROM, AND WHY THE COOKIE'S NAME IS NOT WRITTEN HERE
//
// `describeSessionCookie` is a CONTRACT METHOD, and it is what decides the name.
// `identity-access/domain/session-cookie.ts` picks `__Host-platos_operator_session`
// on an install that terminates TLS and `platos_operator_session` on one that does
// not, because the `__Host-` prefix makes a cookie undeliverable over plain HTTP.
// A transport that hardcoded either name would be a second opinion about a
// decision the contract's banner says core owns outright: "CORE OWNS THE SHAPE; A
// BFF MAY ONLY SET THE BYTES." Asking is one call and cannot drift.
//
// The `Authorization: Bearer` form is accepted as well, and the contract's own
// wording is the reason: `AuthenticateOperatorInput.presentedToken` is documented
// as "the raw cookie OR HEADER value". A dashboard sends the cookie; a script and
// this repository's own integration suite send the header.

import type { DomainError } from "@platos/kernel";
import type { IdentityAccessContract, OperatorAuthorizationView } from "@platos/context-identity-access";
import type { ProvidersContract } from "@platos/context-providers";
import type {
  EnvironmentAccess,
  EnvironmentOperatorAuthorization,
  TenancyContract,
  UserId,
} from "@platos/context-tenancy";
import { asIdentifier, type EnvironmentId } from "@platos/kernel";

import type { AppModule } from "../../app.module.js";
import { raise } from "./fault.js";
import { contextUnavailable } from "./transport-errors.js";

/** Only what this module reads off an inbound request. Structural, so the seam
 * holds no framework-specific request type — the same choice `failure.ts` makes
 * for the response it writes. */
export interface InboundOperatorRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Express sets this from the connection, and from `X-Forwarded-Proto` only
   * when a trust proxy is configured. Absent on a bare Node request. */
  readonly secure?: boolean;
}

/**
 * Whether the browser reached this install over TLS.
 *
 * IT READS THE CONNECTION AND NOT A HEADER. `X-Forwarded-Proto` is caller-supplied
 * unless a proxy is trusted, and treating it as authority would let a caller
 * choose which cookie name this process looks for — an attacker-selected branch
 * in an authentication path. Express already owns that decision (`req.secure`
 * consults the header only when `trust proxy` is set), so this defers to it and
 * adds nothing.
 */
export function isSecureTransport(request: InboundOperatorRequest): boolean {
  return request.secure === true;
}

/** The `Bearer` token on a request, or null. */
function bearerToken(request: InboundOperatorRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/u.exec(header);
  return match?.[1] ?? null;
}

/**
 * One cookie's value out of a `Cookie` header, by exact name.
 *
 * Written here rather than pulled in as a parser because the alternative is a
 * dependency on this deployable's production graph for six lines, and because
 * every cookie this process reads is one the CONTRACT named — there is no need
 * to parse cookies it has no name for. A repeated name yields the FIRST value,
 * which is what browsers send for the more specific path and what every server
 * implementation agrees on.
 */
export function readCookie(request: InboundOperatorRequest, name: string): string | null {
  const header = request.headers["cookie"];
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

/**
 * The composed `identity-access`, or a 503 that says which context is missing.
 *
 * A route reaching `contexts.identityAccess` and finding `undefined` would throw
 * a TypeError, which the exception filter reports as `TRANSPORT_UNHANDLED_FAULT`
 * — a DEFECT, with a 500 and an error id for an operator to chase. That is the
 * wrong answer to a correctly-configured process that simply has no database URL,
 * and it is the answer this surface would give without this function.
 */
export function requireIdentityAccess(app: AppModule): IdentityAccessContract {
  const identityAccess = app.contexts.identityAccess;
  if (identityAccess === undefined) raise(contextUnavailable("identity-access"));
  return identityAccess;
}

/**
 * The credential the caller presented, or null.
 *
 * NULL IS NOT AN ERROR HERE. `authenticateOperator` documents an absent token as
 * "not an error case" and answers `UNAUTHENTICATED { reason: "no-token" }` itself,
 * so this seam hands it the null rather than short-circuiting. That keeps ONE
 * decision about what an anonymous request means, in the context that owns it.
 */
export function presentedOperatorToken(
  identityAccess: IdentityAccessContract,
  request: InboundOperatorRequest,
): string | null {
  const shape = identityAccess.describeSessionCookie({ secure: isSecureTransport(request) });
  // A refused shape means the install's own cookie policy is unsatisfiable, which
  // is a configuration fault and not this caller's. It is reported as the
  // contract's own `INVALID_SESSION_COOKIE` rather than swallowed into a 401,
  // because a 401 would send an operator looking at their session.
  if (!shape.ok) raise(shape.error);
  return readCookie(request, shape.value.name) ?? bearerToken(request);
}

/**
 * Authenticate the operator behind a request, or refuse with the context's own
 * code.
 *
 * The return is the CONTRACT's view — `sessionId`, the real actor, the effective
 * user under impersonation, the email and the expiry — and never a session
 * record. `identity-access/contracts/index.ts` is explicit that a consumer
 * receiving `OperatorSessionRecord` would hold `tokenHash` and the impersonation
 * chain, "internals it has no business with".
 */
export async function authenticateOperator(
  app: AppModule,
  request: InboundOperatorRequest,
): Promise<OperatorAuthorizationView> {
  const identityAccess = requireIdentityAccess(app);
  const authenticated = await identityAccess.authenticateOperator({
    presentedToken: presentedOperatorToken(identityAccess, request),
  });
  // UNEDITED. See the banner: the four refusals are four answers.
  if (!authenticated.ok) raise(authenticated.error as DomainError);
  return authenticated.value;
}

/** The composed `tenancy`, or a 503 that says which context is missing. */
export function requireTenancy(app: AppModule): TenancyContract {
  const tenancy = app.contexts.tenancy;
  if (tenancy === undefined) raise(contextUnavailable("tenancy"));
  return tenancy;
}

/**
 * The operator's identity as tenancy takes it.
 *
 * BOTH IDS TRAVEL, and dropping either would be a security defect rather than an
 * omission. `OperatorPrincipal` carries `actorUserId` (the real human) and
 * `effectiveUserId` (whose privileges apply while impersonating) because
 * `decideEnvironmentAccess` evaluates memberships for the EFFECTIVE user and
 * stamps the ACTOR onto the authorization it mints. A transport that passed one
 * value twice would either evaluate an impersonator's own permissions or attribute
 * the impersonated account's actions to the wrong human.
 */
export function operatorPrincipal(operator: OperatorAuthorizationView): {
  readonly actorUserId: UserId;
  readonly effectiveUserId: UserId;
} {
  return {
    actorUserId: asIdentifier<UserId>(operator.actorUserId),
    effectiveUserId: asIdentifier<UserId>(operator.effectiveUserId),
  };
}

/**
 * The four-gate RBAC decision for one environment, or tenancy's own refusal.
 *
 * THIS IS THE GUARD THAT MUST NOT BE TURNED INTO AN EMPTY PAGE. A listing whose
 * authorization failed and which answered `200 {"data":[]}` would tell an operator
 * that an environment they cannot see is EMPTY — indistinguishable, to them and to
 * a support engineer, from an environment that really is. The refusal is raised,
 * so it reaches the wire as `TENANCY_ENVIRONMENT_FORBIDDEN` at 403 with
 * `details.gate` recording which of the four gates closed.
 *
 * `metadata` is the access level asked for, and it is the WEAKEST one:
 * `EnvironmentAccess` is `"metadata" | "secret:mutate"`, and a read of the end-user
 * directory is not a secret mutation. Asking for more than a route needs is how a
 * viewer-shaped role stops being able to read anything.
 */
export async function authorizeEnvironment(
  app: AppModule,
  operator: OperatorAuthorizationView,
  environmentId: string,
  access: EnvironmentAccess = "metadata",
): Promise<EnvironmentOperatorAuthorization> {
  const tenancy = requireTenancy(app);
  const authorized = await tenancy.authorizeEnvironmentOperator({
    environmentId: asIdentifier<EnvironmentId>(environmentId),
    operator: operatorPrincipal(operator),
    access,
  });
  if (!authorized.ok) raise(authorized.error as DomainError);
  return authorized.value;
}

/**
 * The composed `providers`, or a 503 that says which context is missing.
 *
 * WIN-302 (M2/M4 reachable). It sits beside `requireIdentityAccess` and
 * `requireTenancy` rather than in the one controller that needs it, and the
 * reason is the rule this file's banner opens with: two guards spelling the same
 * rule differently is how one of them ends up not spelling it at all. A
 * controller that reached `app.contexts.providers` and found `undefined` would
 * throw a TypeError, which the exception filter reports as
 * `TRANSPORT_UNHANDLED_FAULT` — a 500 and an error id for an operator to chase,
 * for a correctly-configured process that simply has no root key ring.
 *
 * `providers` IS THE FIRST CONTEXT THIS SEAM NAMES THAT IS COMPOSED FROM PEERS,
 * so it is absent for more reasons than a missing adapter: `app.module.ts` leaves
 * it undefined when EITHER `tenancy` or `secrets` is undefined. The 503 carries
 * the context's own name and `readiness` carries the cause, which is the split
 * `AppModule.unwired` exists for — this answer says WHICH context a route needed,
 * not why the install has not got it.
 */
export function requireProviders(app: AppModule): ProvidersContract {
  const providers = app.contexts.providers;
  if (providers === undefined) raise(contextUnavailable("providers"));
  return providers;
}
