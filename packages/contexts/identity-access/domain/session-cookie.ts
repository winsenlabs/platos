// The operator session-cookie exchange contract.
//
// WHY CORE OWNS THE SHAPE. Every attribute that makes a session cookie safe —
// the `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite`, `Path`, the absence of
// `Domain`, and how long it lives — was decided in
// `apps/webapp/app/services/auth.server.ts`:
//
//     const OPERATOR_SESSION_COOKIE_NAME =
//       env.NODE_ENV === "production"
//         ? "__Host-platos_operator_session" : "platos_operator_session";
//     createCookie(name, { httpOnly: true, path: "/", sameSite: "lax",
//                          secure: env.NODE_ENV === "production" })
//
// A front end deciding the security properties of the credential Core issues is
// the wrong way round: the second BFF, or the first one written by somebody who
// has not read this file, decides them again and gets one of them wrong. Core
// decides them here; a BFF may only set the bytes.
//
// WHAT "MAY ONLY SET THE BYTES" DOES AND DOES NOT MEAN. Nothing inside one
// process can stop a BFF writing whatever `Set-Cookie` header it likes. What is
// enforceable is the SEAM: a directive is frozen and registered when it is
// minted, so a value that was modified — `secure` flipped off, the expiry pushed
// out, the token swapped — is refused when it is handed back for verification.
// That turns "the BFF only sets the bytes" from an assertion into something a
// transport test can check, and it is the same construction
// `tenancy/domain/authorization.ts` uses for an authorization.
//
// THE `__Host-` RULES ARE NOT STYLE (RFC 6265bis §4.1.3.2). A cookie whose name
// begins `__Host-` is accepted by a browser only if it is `Secure`, has
// `Path=/`, and carries NO `Domain` attribute. Together those mean no sibling
// subdomain and no plaintext origin can write it — which is exactly the
// session-fixation route a same-site attacker would otherwise have. A name with
// that prefix and a missing attribute is worse than the plain name: the cookie
// is silently DROPPED by the browser, so logging in appears to do nothing.
// Every one of those combinations is refused below rather than corrected,
// because a corrected shape is a shape somebody believes they chose.

import { domainError, err, ok, type DomainError, type Result } from "@platos/kernel";

/** The name on an install that terminates TLS. Carries the prefix. */
export const HOST_OPERATOR_SESSION_COOKIE_NAME = "__Host-platos_operator_session";
/** The name everywhere else. The prefix would make the cookie undeliverable. */
export const OPERATOR_SESSION_COOKIE_NAME = "platos_operator_session";
/** RFC 6265bis §4.1.3.2. */
export const HOST_COOKIE_PREFIX = "__Host-";

/**
 * Every attribute of the cookie except its value and its lifetime.
 *
 * `domain` is present and always null. It is not an omission a future edit could
 * "fix" by adding one: `__Host-` forbids the attribute outright, and a
 * session cookie scoped to a parent domain is readable by every subdomain the
 * organization has ever pointed at anything.
 */
export interface SessionCookieShape {
  readonly name: string;
  readonly httpOnly: true;
  readonly path: "/";
  readonly sameSite: "lax" | "strict";
  readonly secure: boolean;
  readonly domain: null;
}

/** What a BFF sets, and the only thing it is entitled to decide nothing about. */
export interface SessionCookieDirective {
  readonly shape: SessionCookieShape;
  /** The raw session token, or the empty string when clearing. */
  readonly value: string;
  readonly expiresAt: Date;
  /** Whole seconds, never negative. Zero means "expire now". */
  readonly maxAgeSeconds: number;
}

const issuedDirectives = new WeakSet<object>();

export function invalidSessionCookie(reason: string): DomainError {
  return domainError("INVALID_SESSION_COOKIE", "precondition_failed", reason, {
    details: { reason },
  });
}

/**
 * The shape for an install, decided by ONE fact: whether the browser reaches
 * it over TLS.
 *
 * Everything else follows, and follows the same way the extraction source
 * decided it. `sameSite: "lax"` is what the source uses and what a session
 * cookie needs: `strict` would break every inbound link into an authenticated
 * page, and `none` would send the credential on cross-site requests, which is
 * the CSRF the attribute exists to stop. `none` is not in the type.
 */
export function describeSessionCookie(transport: { readonly secure: boolean }): SessionCookieShape {
  return Object.freeze({
    name: transport.secure ? HOST_OPERATOR_SESSION_COOKIE_NAME : OPERATOR_SESSION_COOKIE_NAME,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: transport.secure,
    domain: null,
  } as const);
}

/**
 * Refuse a shape a browser would drop, or one that weakens the credential.
 *
 * Called on every mint, so no directive can carry a shape that fails it, and
 * exported so a transport that assembles its own can be checked against the same
 * rules rather than a second reading of the RFC.
 */
export function checkSessionCookieShape(shape: SessionCookieShape): Result<SessionCookieShape> {
  if (shape.httpOnly !== true) {
    return err(invalidSessionCookie("a session cookie must be HttpOnly"));
  }
  if (shape.path !== "/") {
    return err(invalidSessionCookie("a session cookie must be scoped to Path=/"));
  }
  if (shape.domain !== null) {
    return err(invalidSessionCookie("a session cookie must carry no Domain attribute"));
  }
  if (shape.sameSite !== "lax" && shape.sameSite !== "strict") {
    return err(invalidSessionCookie("SameSite must be lax or strict"));
  }
  if (shape.name.startsWith(HOST_COOKIE_PREFIX) && !shape.secure) {
    // A browser drops this outright, so the symptom is "logging in does
    // nothing" rather than a warning anybody would read.
    return err(invalidSessionCookie("the __Host- prefix requires Secure"));
  }
  if (shape.secure && !shape.name.startsWith(HOST_COOKIE_PREFIX)) {
    // The other direction matters too: a secure install that dropped the
    // prefix would accept a cookie written by any sibling subdomain, which is
    // session fixation with no exploit needed.
    return err(invalidSessionCookie("a secure install must use the __Host- prefixed name"));
  }
  return ok(shape);
}

export interface IssueSessionCookieInput {
  readonly shape: SessionCookieShape;
  /** The raw token `issueOperatorSession` returned. Never a hash. */
  readonly token: string;
  /** The session's own expiry. The cookie may not outlive it. */
  readonly sessionExpiresAt: Date;
  readonly now: Date;
  /**
   * Optional, and never longer than the session. Supplied when a caller wants a
   * SHORTER browser lifetime than the session row — a shared machine, say.
   */
  readonly expiresAt?: Date;
}

/**
 * Mint the directive for a live session.
 *
 * THE COOKIE NEVER OUTLIVES THE SESSION. A browser holding a credential the
 * store already considers expired produces a request that authenticates as far
 * as the cookie and then fails at the session — an error the user cannot act on
 * and an operator cannot distinguish from a revocation. So a requested expiry
 * beyond the session's is REFUSED, not silently reduced.
 */
export function issueSessionCookie(
  input: IssueSessionCookieInput,
): Result<SessionCookieDirective> {
  const shape = checkSessionCookieShape(input.shape);
  if (!shape.ok) return shape;
  if (input.token.length === 0) {
    return err(invalidSessionCookie("a session cookie needs a token; use the clear directive"));
  }
  if (input.sessionExpiresAt.getTime() <= input.now.getTime()) {
    return err(invalidSessionCookie("the session has already expired"));
  }
  const expiresAt = input.expiresAt ?? input.sessionExpiresAt;
  if (expiresAt.getTime() > input.sessionExpiresAt.getTime()) {
    return err(invalidSessionCookie("a session cookie may not outlive its session"));
  }
  if (expiresAt.getTime() <= input.now.getTime()) {
    return err(invalidSessionCookie("a session cookie must expire in the future"));
  }
  return ok(
    mint({
      shape: shape.value,
      value: input.token,
      expiresAt,
      maxAgeSeconds: Math.floor((expiresAt.getTime() - input.now.getTime()) / 1000),
    }),
  );
}

/**
 * The directive that ends a session in the browser.
 *
 * Empty value, an expiry at the epoch and `Max-Age: 0`, all three — the
 * extraction source's `cookie.serialize("", { expires: new Date(0), maxAge: 0 })`.
 * All three because they are read by different things: a browser honouring
 * `Max-Age` ignores `Expires`, one that does not honours `Expires`, and the
 * empty value is what a proxy or a browser that honours neither is left holding.
 *
 * The SHAPE must still be valid. A logout that emitted a differently-shaped
 * cookie would not overwrite the one that is there — a browser keys a cookie by
 * name, domain and path — so the session would stay in the browser.
 */
export function clearSessionCookie(shape: SessionCookieShape): Result<SessionCookieDirective> {
  const checked = checkSessionCookieShape(shape);
  if (!checked.ok) return checked;
  return ok(
    mint({ shape: checked.value, value: "", expiresAt: new Date(0), maxAgeSeconds: 0 }),
  );
}

export interface RotateSessionCookieInput extends IssueSessionCookieInput {
  /** The token being replaced. Refused if the "new" one is the same. */
  readonly previousToken: string;
}

/**
 * Re-issue after the session token changes — a second factor verified, an
 * impersonation started or stopped.
 *
 * Each of those mints a NEW `OperatorSession`, so the browser must be given the
 * new token. Re-issuing the OLD one under a new expiry is the failure this
 * refuses: it looks exactly like a rotation, it passes any test that only checks
 * a cookie was set, and it leaves the escalated session reachable with the
 * credential that existed before the escalation.
 */
export function rotateSessionCookie(
  input: RotateSessionCookieInput,
): Result<SessionCookieDirective> {
  if (input.token === input.previousToken) {
    return err(invalidSessionCookie("a rotation must issue a different token"));
  }
  return issueSessionCookie(input);
}

/**
 * Recognise a directive this module minted and nobody has modified since.
 *
 * Identity, not shape: a field-by-field copy is not the value that was issued,
 * so `{ ...directive, shape: { ...shape, secure: false } }` is rejected. See the
 * note at the top for what this does and does not enforce.
 */
export function isSessionCookieDirective(value: unknown): value is SessionCookieDirective {
  if (typeof value !== "object" || value === null) return false;
  return issuedDirectives.has(value) && Object.isFrozen(value);
}

function mint(directive: SessionCookieDirective): SessionCookieDirective {
  const frozen = Object.freeze({ ...directive });
  issuedDirectives.add(frozen);
  return frozen;
}
