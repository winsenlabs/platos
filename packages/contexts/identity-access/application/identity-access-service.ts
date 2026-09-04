// The composition of identity-access's use cases into the published
// `IdentityAccessContract`.
//
// WHY THIS FILE EXISTS. Until now `IdentityAccessContract` was an interface with
// no implementation anywhere in the repository: `tenancy`, `tools`, `channels`
// and `apps/core-api` all NAME the type, and not one of them could have been
// handed a value of it. A published interface nothing inhabits is a wish, and
// `apps/core-api/src/app.module.ts` recorded that as a finding rather than
// absorbing it. This is the answer to it.
//
// IT TAKES NO DECISION. Every rule lives in `domain/`; every read plan lives in
// the use case this delegates to. What this file owns is the PROJECTION: turning
// a domain authorization — which carries token hashes, parent sessions and the
// impersonation chain — into the flat, serialisable view a consumer is entitled
// to see. ADR M0.3 §2 is explicit that the DTOs are not the entities, and this
// is the one place the two meet.
//
// THE REFUSALS PASS STRAIGHT THROUGH. A use case returns `Result`, and so does
// every method here: nothing is caught, re-coded or widened. A denial keeps the
// code the domain minted, so a transport maps ONE failure catalogue rather than
// discovering a second one at this seam.

import {
  checkSessionCookieShape,
  clearSessionCookie,
  describeSessionCookie,
  invalidSessionCookie,
  isSessionCookieDirective,
  issueSessionCookie,
  rotateSessionCookie,
  scopeKindOf,
  type AuthorizationScope,
  type BearerAuthorization,
  type EndUserWithIdentities,
  type OperatorAuthorization,
  type SessionCookieDirective,
  type PermittedRateLimitDecision,
} from "../domain/index.js";
import type {
  AuthenticateBearerRequest,
  AuthenticateOperatorRequest,
  AuthorizationScopeView,
  EndUserPageView,
  IdentityAccessContract,
  IssueSessionCookieRequest,
  ListEndUsersRequest,
  RotateSessionCookieRequest,
  SessionCookieDirectiveView,
  SessionCookieShapeView,
  SessionTransport,
  OperatorAuthorizationView,
  PrincipalAuthorizationView,
  RateLimitDecisionView,
  RateLimitRequest,
} from "../contracts/index.js";
import { authenticateBearerToken } from "./authenticate-bearer-token.js";
import { listEndUsers, type EndUserPage } from "./list-end-users.js";
import { authenticateOperator } from "./authenticate-operator.js";
import { consumeRateLimit } from "./consume-rate-limit.js";
import type { IdentityAccessPorts } from "./dependencies.js";
import { err, ok, type Result } from "@platos/kernel";

/**
 * Flatten a grant's reach for the wire.
 *
 * The domain models GLOBAL as a variant with NO tenant field; the contract keeps
 * a nullable one because it has to survive JSON. `tenant` is null exactly when
 * `kind` is `GLOBAL`, which is the invariant the two representations agree on.
 */
function scopeView(scope: AuthorizationScope): AuthorizationScopeView {
  return {
    kind: scopeKindOf(scope),
    tenant: scope.kind === "GLOBAL" ? null : scope.tenant,
  };
}

/**
 * Project an operator authorization.
 *
 * `sessionId`, `actorUserId` and `effectiveUserId` are branded strings in the
 * domain and plain strings on the contract: a consumer holding a `UserId` brand
 * could pass it back into a lookup that expects one, which is precisely the
 * coupling `contracts/` exists to prevent.
 *
 * `impersonating` carries the TARGET only. Who is really acting is already
 * `actorUserId`, and repeating it inside the nested object would create two
 * places for the same fact to be read from.
 */
function operatorView(authorization: OperatorAuthorization): OperatorAuthorizationView {
  return {
    sessionId: authorization.sessionId,
    actorUserId: authorization.actorUserId,
    effectiveUserId: authorization.effectiveUserId,
    email: authorization.email,
    expiresAt: authorization.expiresAt,
    mfaVerifiedAt: authorization.mfaVerifiedAt,
    impersonating:
      authorization.impersonation === null
        ? null
        : { targetUserId: authorization.impersonation.targetUserId },
  };
}

/**
 * Project a bearer authorization.
 *
 * `kind` — which of the four credential tables the row came from — is
 * deliberately dropped. It is a storage fact; a consumer that branched on it
 * would be reimplementing the routing this context owns, and adding a fifth
 * table would then be a breaking change for it.
 */
function principalView(authorization: BearerAuthorization): PrincipalAuthorizationView {
  return {
    principalId: authorization.principalId,
    tier: authorization.tier,
    credentialId: authorization.credentialId,
    scope: scopeView(authorization.scope),
    permissions: authorization.permissions,
  };
}

/**
 * Project a decision that let the request through.
 *
 * There is no `limited` branch to write, and no impossible case to swallow:
 * `consumeRateLimit` returns `PermittedRateLimitDecision`, so a limited decision
 * has already become a failure before this is reached. Both outcomes below are
 * reachable — `degraded` is what a broken limiter produces — and both are
 * covered by a case in the suite.
 */
function rateLimitView(decision: PermittedRateLimitDecision): RateLimitDecisionView {
  return decision.outcome === "allowed"
    ? { outcome: "allowed", remaining: decision.remaining }
    : { outcome: "degraded", remaining: null };
}

/**
 * Project one end user and the identities that reach them.
 *
 * `organizationId` and `identityId` are dropped: the first is the scope the
 * caller already supplied, and the second addresses a row this contract
 * publishes no operation for.
 */
function endUserView(row: EndUserWithIdentities) {
  return {
    endUserId: row.user.endUserId,
    displayName: row.user.displayName,
    disabledAt: row.user.disabledAt,
    createdAt: row.user.createdAt,
    identities: row.identities.map((identity) => ({
      issuer: identity.issuer,
      channel: identity.channel,
      subject: identity.subject,
      verifiedAt: identity.verifiedAt,
      disabledAt: identity.disabledAt,
    })),
  };
}

/** Project a page, keeping the total and the window the use case computed. */
function endUserPageView(page: EndUserPage): EndUserPageView {
  return {
    users: page.users.map(endUserView),
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.hasMore,
  };
}

/**
 * Project a cookie directive — and deliberately DO NOT COPY IT.
 *
 * Every other projection in this file flattens a domain value, because those
 * values carry internals a consumer has no business with. A directive carries
 * nothing but the attributes a BFF has to set, so there is nothing to hide, and
 * copying would cost the one property that matters: the value is frozen and
 * registered when it is minted, and a copy is not the value that was issued.
 * Handing the minted object across is what lets `verifySessionCookie` refuse a
 * directive whose `secure` was flipped off on the way to the header.
 */
function cookieView(directive: SessionCookieDirective): SessionCookieDirectiveView {
  return directive;
}

/**
 * Build the façade.
 *
 * It takes the WHOLE port bundle, unlike a use case, which takes the slice it
 * needs. That is the difference in role: a use case's signature is its dependency
 * list, while the façade is what the composition root hands to a transport, and
 * a transport must not have to know which subset each method reaches for.
 */
export function createIdentityAccessService(ports: IdentityAccessPorts): IdentityAccessContract {
  return {
    name: "identity-access",

    async authenticateOperator(
      request: AuthenticateOperatorRequest,
    ): Promise<Result<OperatorAuthorizationView>> {
      const authorization = await authenticateOperator(ports, {
        presentedToken: request.presentedToken,
      });
      return authorization.ok ? ok(operatorView(authorization.value)) : authorization;
    },

    async authenticateBearer(
      request: AuthenticateBearerRequest,
    ): Promise<Result<PrincipalAuthorizationView>> {
      const authorization = await authenticateBearerToken(ports, {
        presentedToken: request.presentedToken,
        requestedScope: request.requestedScope,
        ...(request.requiredPermission === undefined
          ? {}
          : { requiredPermission: request.requiredPermission }),
      });
      return authorization.ok ? ok(principalView(authorization.value)) : authorization;
    },

    async consumeRateLimit(request: RateLimitRequest): Promise<Result<RateLimitDecisionView>> {
      const decision = await consumeRateLimit(ports, {
        action: request.action,
        identifier: request.identifier,
        scope: request.scope,
        principalId: request.principalId,
      });
      return decision.ok ? ok(rateLimitView(decision.value)) : decision;
    },

    describeSessionCookie(transport: SessionTransport): Result<SessionCookieShapeView> {
      // Minting the shape and CHECKING it are two calls on purpose: the check is
      // the one a transport assembling its own shape has to pass, so running it
      // here proves the shape this context hands out satisfies the same rules
      // rather than being exempt from them.
      return checkSessionCookieShape(describeSessionCookie(transport));
    },

    issueSessionCookie(request: IssueSessionCookieRequest): Result<SessionCookieDirectiveView> {
      const directive = issueSessionCookie({
        shape: describeSessionCookie(request),
        token: request.token,
        sessionExpiresAt: request.sessionExpiresAt,
        now: ports.clock.now(),
        ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      });
      return directive.ok ? ok(cookieView(directive.value)) : directive;
    },

    rotateSessionCookie(request: RotateSessionCookieRequest): Result<SessionCookieDirectiveView> {
      const directive = rotateSessionCookie({
        shape: describeSessionCookie(request),
        token: request.token,
        previousToken: request.previousToken,
        sessionExpiresAt: request.sessionExpiresAt,
        now: ports.clock.now(),
        ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      });
      return directive.ok ? ok(cookieView(directive.value)) : directive;
    },

    clearSessionCookie(transport: SessionTransport): Result<SessionCookieDirectiveView> {
      const directive = clearSessionCookie(describeSessionCookie(transport));
      return directive.ok ? ok(cookieView(directive.value)) : directive;
    },

    verifySessionCookie(value: unknown): Result<SessionCookieDirectiveView> {
      return isSessionCookieDirective(value)
        ? ok(value)
        : err(invalidSessionCookie("value was not issued by identity-access"));
    },

    async listEndUsers(request: ListEndUsersRequest): Promise<Result<EndUserPageView>> {
      const page = await listEndUsers(ports, {
        scope: request.scope,
        status: request.status ?? null,
        search: request.search ?? null,
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.offset === undefined ? {} : { offset: request.offset }),
      });
      return page.ok ? ok(endUserPageView(page.value)) : page;
    },
  };
}
