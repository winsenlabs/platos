// /api/v1/bff/session — THE ONE TRANSPORT ALLOWED TO PUT A CREDENTIAL IN A
// BROWSER, AND THE SHORTEST FILE IN THE SURFACE BECAUSE OF IT.
//
// WIN-257 T5 published the session-cookie exchange contract and nothing served
// it. `identity-access/contracts/index.ts` states the division this controller
// exists to honour, in its own words: "CORE OWNS THE SHAPE; A BFF MAY ONLY SET
// THE BYTES. Every attribute that makes the credential safe — the `__Host-`
// prefix, `Secure`, `HttpOnly`, `SameSite`, `Path`, the absence of `Domain`, and
// the lifetime — was decided in the Remix tree, where a second front end would
// have decided them again and got one of them wrong."
//
// SO THIS FILE DECIDES NONE OF THEM. It asks `issueSessionCookie` for a
// directive, hands the directive straight back to `verifySessionCookie`, and
// renders the value it gets. There is no `HttpOnly` literal here, no `SameSite`,
// no lifetime arithmetic and no cookie name — every one of those is read off the
// directive, and `serializeSetCookie` below is a renderer with no policy in it.
//
// WHY THE ROUND TRIP THROUGH `verifySessionCookie`. The contract says plainly
// what that method is and is not: "It does not stop a BFF writing whatever header
// it likes — nothing in a process can. It stops a MODIFIED directive being
// accepted back, which is what makes 'the BFF only sets the bytes' checkable at
// the seam." A spread, a re-shape or a hand-built object fails it, because
// membership of the issuing register — not the shape of the value — is what the
// check tests.
//
// -----------------------------------------------------------------------------
// AND IT QUERIES NO CANONICAL STORE
//
// A BFF is the transport most tempted to reach past the contracts: it is the one
// with a browser on the other end asking for a page's worth of joined data. The
// containment is not a convention here. `scripts/arch/composition-root.mjs` (C8)
// refuses ANY file under `apps/core-api/src/transports/**` that reads an
// `adapters` property off the composed application, and its own banner records
// that the rule was written against a real file placed in THIS directory which
// type-checked and passed four other gates. Delete the rule and
// `composition-root.test.mjs` goes red; the mutation ledger records the run.
//
// The exchange therefore reaches exactly two contract methods —
// `authenticateOperator` and `issueSessionCookie` — and the sign-out reaches two,
// `revokeOperatorSession` and `clearSessionCookie`.

import { Body, Controller, Delete, HttpCode, HttpStatus, Inject, Post, Req, Res } from "@nestjs/common";

import type { Result } from "@platos/kernel";
import type { SessionCookieDirectiveView } from "@platos/context-identity-access";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { BodyReader, jsonBody } from "../rest/body.js";
import { REST_APPLICATION, type RestApplication } from "../rest/dependencies.js";
import { itemEnvelope, type ItemEnvelope } from "../rest/envelope.js";
import { raise } from "../rest/fault.js";
import {
  operatorSessionResource,
  type OperatorSessionResource,
} from "../rest/resources.js";
import {
  authenticateOperator,
  isSecureTransport,
  presentedOperatorToken,
  requireIdentityAccess,
  type InboundOperatorRequest,
} from "../rest/operator.js";

/** Only the one method this controller calls on a response. */
export interface CookieResponse {
  setHeader(name: string, value: string): unknown;
}

export interface ExchangeSessionBody {
  readonly token: string;
}

export const exchangeSessionValidator = (input: unknown): Result<ExchangeSessionBody> => {
  const body = jsonBody(input);
  if (!body.ok) return body;
  const reader = new BodyReader(body.value);
  const token = reader.string("token");
  return reader.finish({ token });
};

const EXCHANGE_SESSION_PIPE = new DomainValidationPipe(exchangeSessionValidator);

/**
 * A directive as one `Set-Cookie` header.
 *
 * EVERY ATTRIBUTE IS READ, NONE IS CHOSEN. `Domain` has no branch at all: the
 * directive's `domain` is typed `null` and documented as "Always null. `__Host-`
 * forbids the attribute", so a `Domain=` here could only ever contradict the
 * contract. `Max-Age` AND `Expires` are both written because they are the two
 * halves RFC 6265 §4.1.2 gives for the same fact and old browsers honour only the
 * second; the directive supplies both, already agreed.
 *
 * `SameSite` is rendered with its first letter upper-cased because the RFC's
 * grammar for the attribute value is case-insensitive but several deployed
 * browsers historically were not, and the contract publishes the lower-case form.
 * That is a rendering decision about bytes, which is the only kind this file is
 * allowed to make.
 */
export function serializeSetCookie(directive: SessionCookieDirectiveView): string {
  const { shape } = directive;
  const sameSite = `${shape.sameSite.charAt(0).toUpperCase()}${shape.sameSite.slice(1)}`;
  const parts = [
    `${shape.name}=${encodeURIComponent(directive.value)}`,
    `Path=${shape.path}`,
    `Max-Age=${String(directive.maxAgeSeconds)}`,
    `Expires=${directive.expiresAt.toUTCString()}`,
    `SameSite=${sameSite}`,
  ];
  if (shape.httpOnly) parts.push("HttpOnly");
  if (shape.secure) parts.push("Secure");
  return parts.join("; ");
}

@Controller({ path: "bff/session", version: API_VERSION })
export class BffSessionController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  /**
   * Put a live operator session in the browser.
   *
   * THE TOKEN IS AUTHENTICATED FIRST, and not as a courtesy. `issueSessionCookie`
   * takes the session's own `expiresAt` and refuses a cookie asked to outlive it;
   * the only honest source of that instant is the session itself, so the exchange
   * has to ask `authenticateOperator` for it. That the exchange therefore refuses
   * an unknown, expired or revoked token — each with its own code — is a
   * consequence of needing the expiry, not a guard bolted on beside it.
   *
   * IT MINTS NOTHING, which is why `http/idempotency-policy.ts` gains no row. The
   * eight `required` operations are the one-time-secret mints, "returned once and
   * never readable again"; this route moves a credential the CALLER ALREADY HOLDS
   * from a request body into a cookie. A replay hands back the same cookie for the
   * same token, which is what the caller asked for both times.
   */
  // 200, NOT NEST'S DEFAULT 201, AND THE SUITE IS WHAT FOUND IT. Nest answers
  // every POST 201 unless a handler says otherwise, and this handler CREATES
  // NOTHING: it moves a credential the caller already holds from a request body
  // into a cookie, and returns the session that already existed. A 201 would tell
  // a client a resource had been created and — with no `Location` to go with it —
  // would be a status nobody could act on. `POST /organizations` and
  // `POST /projects` keep the 201 they earn, which is what makes this an explicit
  // decision rather than a blanket.
  @Post()
  @HttpCode(HttpStatus.OK)
  async exchange(
    @Req() request: InboundOperatorRequest,
    @Res({ passthrough: true }) response: CookieResponse,
    @Body(EXCHANGE_SESSION_PIPE) body: ExchangeSessionBody,
  ): Promise<ItemEnvelope<OperatorSessionResource>> {
    const app = this.application.app;
    const identityAccess = requireIdentityAccess(app);
    const authenticated = await identityAccess.authenticateOperator({ presentedToken: body.token });
    if (!authenticated.ok) raise(authenticated.error);

    const directive = identityAccess.issueSessionCookie({
      token: body.token,
      sessionExpiresAt: authenticated.value.expiresAt,
      secure: isSecureTransport(request),
    });
    if (!directive.ok) raise(directive.error);
    response.setHeader("Set-Cookie", serializeSetCookie(this.onlyTheBytes(directive.value)));
    return itemEnvelope(operatorSessionResource(authenticated.value));
  }

  /**
   * End the session — on the SERVER first, then in the browser.
   *
   * WIN-267 W3. Until this tranche the handler wrote one header and stopped, and
   * the comment that stood here said so in as many words: "IT REVOKES NOTHING
   * EITHER ... this route clears the browser and the session dies of its own
   * expiry." That is now closed, because a sign-out that only clears a cookie is
   * a sign-out that tells the user something untrue. The cookie is a COPY of the
   * credential; deleting the copy in the one browser that asked leaves every
   * other copy — the one in a proxy log, the one an attacker pasted into their
   * own client — valid for the rest of the session's lifetime, which for this
   * install is days. `revokeOperatorSession` ends the row, and
   * `identity-rest.integration.test.ts` replays the exact same cookie afterwards
   * against a real PostgreSQL and reads the row back to prove it.
   *
   * THE ORDER IS NOT INTERCHANGEABLE. The revocation happens BEFORE the header
   * is written, so a store that cannot be reached refuses the sign-out instead of
   * answering 204 over a session that is still live. Clearing first and revoking
   * second would produce exactly the lie this change exists to remove, with the
   * added twist that the user would no longer hold the cookie needed to try
   * again.
   *
   * IT STILL DOES NOT AUTHENTICATE, AND THAT IS STILL THE POINT. A browser
   * holding a cookie for a session that is already expired, already revoked, or
   * that no row matches is exactly the browser that most needs the cookie
   * cleared, and a 401 would strand it there. So every refusal in the
   * `unauthenticated` CATEGORY — no token, no such session, already ended — means
   * "there was nothing left to end", and the route goes on to clear the browser
   * and answer 204. The branch is written against the kernel's category rather
   * than a list of codes copied into this file, so a fourth way for a credential
   * to be unestablishable does not need a transport edit to be handled.
   *
   * ANYTHING ELSE IS RAISED. In practice that is `IDENTITY_STORE_UNAVAILABLE` at
   * 503: the server could not end the session, and the honest answer is to say
   * so rather than to clear the cookie and call it done.
   *
   * IT STILL REVEALS NOTHING. A live token, an unknown token and no token at all
   * get the same 204 and the same bytes, so the route cannot be used to ask
   * whether a token is real.
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(
    @Req() request: InboundOperatorRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    const identityAccess = requireIdentityAccess(this.application.app);
    const ended = await identityAccess.revokeOperatorSession({
      presentedToken: presentedOperatorToken(identityAccess, request),
    });
    if (!ended.ok && ended.error.category !== "unauthenticated") raise(ended.error);
    const directive = identityAccess.clearSessionCookie({ secure: isSecureTransport(request) });
    if (!directive.ok) raise(directive.error);
    response.setHeader("Set-Cookie", serializeSetCookie(this.onlyTheBytes(directive.value)));
  }

  /**
   * The directive, handed back to the context that minted it.
   *
   * See the banner. This is the seam that makes "a BFF may only set the bytes"
   * something a test can fail rather than something a comment claims.
   */
  private onlyTheBytes(directive: SessionCookieDirectiveView): SessionCookieDirectiveView {
    const verified = requireIdentityAccess(this.application.app).verifySessionCookie(directive);
    if (!verified.ok) raise(verified.error);
    return verified.value;
  }
}
