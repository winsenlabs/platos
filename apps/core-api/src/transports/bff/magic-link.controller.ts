// /api/v1/bff/magic-link — SIGNING IN WITHOUT A PASSWORD, AND WITHOUT A TOKEN IN
// ANY RESPONSE.
//
// The webapp's `login._index` and `magic.tsx` are two of the flows T8 deletes
// from the Remix tree: the first called `operatorAuth.issueMagicLink` and mailed
// the link through Resend itself, the second called `consumeMagicLink` and wrote
// the cookie. Both now reach PUBLISHED contract methods, and D20 (2026-09-15)
// decided the part that mattered: "core-api sends it through the notifier-email
// adapter. A login-capable token is never returned to the BFF."
//
// SO NEITHER ROUTE HAS A FIELD A TOKEN COULD BE IN.
//
//   POST /bff/magic-link            `startMagicLinkLogin` hands the link to the
//                                   `MagicLinkDelivery` port and answers with the
//                                   address and the expiry. 202: the relay accepted
//                                   it, and the rest happens in an inbox.
//   POST /bff/magic-link/complete   `completeMagicLinkLogin` returns the session
//                                   token INSIDE a directive identity-access minted,
//                                   which this file hands back to
//                                   `verifySessionCookie` and renders into
//                                   `Set-Cookie` — the same path `POST /bff/session`
//                                   takes. The body carries ids and an expiry.
//
// NEITHER AUTHENTICATES, AND BOTH ARE STILL SAFE TO EXPOSE. The start spends the
// LOGIN budget (one bucket per address, the oracle's key) and answers the same
// shape for an address with an account and one without; the completion needs the
// single-use secret from the inbox, and every way it can fail — unknown, expired,
// spent, raced, disabled account — is one `UNAUTHENTICATED`.
//
// THE REFUSALS, EACH ITS OWN CODE:
//
//   TRANSPORT_REQUEST_INVALID         the body is not `{ email }` / `{ token }`
//   INVALID_EMAIL_ADDRESS        400  an address a link cannot be mailed to
//   MAGIC_LINK_DELIVERY_UNAVAILABLE 503 no relay composed; nothing minted
//   RATE_LIMITED                 429  the address spent its LOGIN budget
//   RATE_LIMIT_FAILED_CLOSED     503  the limiter is unreachable (D3)
//   MAGIC_LINK_DELIVERY_FAILED   503  the relay did not accept the message
//   UNAUTHENTICATED              401  the link cannot be spent
//
// DIVERGENCE, RECORDED: THERE IS NO DIRECT SIGN-IN. The oracle's login action has
// a non-production branch — `NODE_ENV !== "production"` and `BACKDOOR_PLATOS_DEV`
// or `PLATOS_TEST_MODE` set to "1", optionally pinned to `BACKDOOR_PLATOS_DEV_EMAIL`
// — that calls `issueMagicLink`, spends the token at once with `consumeMagicLink`
// and answers `Set-Cookie`, mailing nothing. It is not ported, and D20 is why: the
// branch works only because the BFF holds the login-capable token, which is the
// one thing D20 says it never receives, and a route that turned D20 off by an
// environment flag would be a sign-in-as-anyone endpoint one misconfiguration
// from production. Measured at this tranche's base, nothing tracked turns the
// branch ON: the webapp declares the flags (`env.server.ts`), its route test
// mocks both to "0" (`test/operatorSessionRouteEvidence.test.ts`), both compose
// files pass `PLATOS_TEST_MODE` to the AGENT service only, and
// `content/docs/credential-inventory.md` lists `BACKDOOR_PLATOS_DEV` as a
// development-only bypass. What is lost is a developer's hand-set local sign-in,
// and T8 must say so when it deletes the Remix action. The next step is the one
// `composition/identity-tenancy-rest.integration.test.ts` already takes: point
// `PLATOS_CHANNELS_EMAIL_SMTP_URL` at a test relay (Mailpit), and have the harness
// read the link out of the relay's API and POST it to `/bff/magic-link/complete`.
//
// IDEMPOTENCY. The start takes the unlisted default, `accepted`: a key a caller
// sends is honoured, so a retried form submission does not mail a second link,
// and none is demanded, because the one-time secret is never in the response a
// replay would have to reproduce. The completion is `exempt` in
// `http/idempotency-policy.ts`, with the reason there.

import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, Res } from "@nestjs/common";

import type { Result } from "@platos/kernel";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { BodyReader, jsonBody } from "../rest/body.js";
import { REST_APPLICATION, type RestApplication } from "../rest/dependencies.js";
import { itemEnvelope, type ItemEnvelope } from "../rest/envelope.js";
import { raise } from "../rest/fault.js";
import { isSecureTransport, requireIdentityAccess, type InboundOperatorRequest } from "../rest/operator.js";
import { instant } from "../rest/resources.js";
import { serializeSetCookie, type CookieResponse } from "./session.controller.js";

export interface StartMagicLinkBody {
  readonly email: string;
}

export interface CompleteMagicLinkBody {
  /** The single-use secret from the link, exactly as the `?token=` parameter carried it. */
  readonly token: string;
}

/** What a started sign-in reports. The same shape for every address. */
export interface MagicLinkRequestResource {
  readonly email: string;
  readonly expiresAt: string;
}

/** A completed sign-in. The session itself is in `Set-Cookie` and nowhere else. */
export interface MagicLinkSessionResource {
  readonly userId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

/** SHAPE ONLY — the address grammar is identity-access's `INVALID_EMAIL_ADDRESS`. */
export const startMagicLinkValidator = (input: unknown): Result<StartMagicLinkBody> => {
  const body = jsonBody(input);
  if (!body.ok) return body;
  const reader = new BodyReader(body.value);
  const email = reader.string("email");
  return reader.finish({ email });
};

export const completeMagicLinkValidator = (input: unknown): Result<CompleteMagicLinkBody> => {
  const body = jsonBody(input);
  if (!body.ok) return body;
  const reader = new BodyReader(body.value);
  const token = reader.string("token");
  return reader.finish({ token });
};

const START_PIPE = new DomainValidationPipe(startMagicLinkValidator);
const COMPLETE_PIPE = new DomainValidationPipe(completeMagicLinkValidator);

@Controller({ path: "bff/magic-link", version: API_VERSION })
export class BffMagicLinkController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async start(@Body(START_PIPE) body: StartMagicLinkBody): Promise<ItemEnvelope<MagicLinkRequestResource>> {
    const started = await requireIdentityAccess(this.application.app).startMagicLinkLogin({
      email: body.email,
    });
    if (!started.ok) raise(started.error);
    return itemEnvelope({ email: started.value.email, expiresAt: instant(started.value.expiresAt) });
  }

  /**
   * 200 AND NOT 201, for the reason `POST /bff/session` gives: no addressable
   * resource is created for the caller, a session is put in the browser.
   */
  @Post("complete")
  @HttpCode(HttpStatus.OK)
  async complete(
    @Req() request: InboundOperatorRequest,
    @Res({ passthrough: true }) response: CookieResponse,
    @Body(COMPLETE_PIPE) body: CompleteMagicLinkBody,
  ): Promise<ItemEnvelope<MagicLinkSessionResource>> {
    const identityAccess = requireIdentityAccess(this.application.app);
    const completed = await identityAccess.completeMagicLinkLogin({
      presentedToken: body.token,
      secure: isSecureTransport(request),
    });
    if (!completed.ok) raise(completed.error);
    // THE DIRECTIVE GOES BACK TO THE CONTEXT THAT MINTED IT before a byte is
    // written — the check that makes "a BFF only sets the bytes" falsifiable.
    const directive = identityAccess.verifySessionCookie(completed.value.cookie);
    if (!directive.ok) raise(directive.error);
    response.setHeader("Set-Cookie", serializeSetCookie(directive.value));
    return itemEnvelope({
      userId: completed.value.userId,
      sessionId: completed.value.sessionId,
      expiresAt: instant(completed.value.expiresAt),
    });
  }
}
