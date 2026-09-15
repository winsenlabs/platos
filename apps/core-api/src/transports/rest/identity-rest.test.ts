// THE PARTS OF THE V1 IDENTITY SURFACE THAT NEED NO SERVER, AND ONE FINDING.
//
// The behaviour of these routes is proven over HTTP against a real PostgreSQL in
// `transports/identity-rest.integration.test.ts`. What is here is the half that
// would be silently correct in that suite and wrong in production: the rules that
// decide what a request MEANS before any store is reached, and the cookie bytes,
// which an integration suite can only observe through a `Set-Cookie` header it
// also has to parse.
//
// EVERY JOIN IS TO SOMETHING THIS FILE DOES NOT CONTROL. The cookie cases run
// against a REAL `IdentityAccessContract` built by `createIdentityAccessService`,
// so the attributes come from `identity-access/domain/session-cookie.ts` and not
// from a fixture; the contract-shape case reads the method names off that same
// object.

import { describe, expect, it } from "vitest";

import { domainError, err, ok, type DomainError, type FieldViolation } from "@platos/kernel";
import {
  IDENTITY_ACCESS_ERROR_CODES,
  type IdentityAccessContract,
} from "@platos/context-identity-access";

import {
  createIdentityAccessService,
  testPorts,
} from "@platos/context-identity-access/application/index.js";
import { createTenancyFixture, createTenancyService } from "@platos/context-tenancy/application/index.js";

import type { AppModule } from "../../app.module.js";
import { BffSessionController, serializeSetCookie } from "../bff/session.controller.js";
import { exchangeSessionValidator } from "../bff/session.controller.js";
import { domainErrorOf } from "./fault.js";
import { BodyReader, jsonBody } from "./body.js";
import { encodeCursor, wholeCollection } from "./envelope.js";
import {
  endUserQueryValidator,
  nextCursorFor,
  offsetInCursor,
} from "./environment-end-users.controller.js";
import { InvitationsController } from "./invitations.controller.js";
import { createOrganizationValidator } from "./organizations.controller.js";
import { presentedOperatorToken, readCookie } from "./operator.js";
import { refuseUnpagedQuery } from "./page.js";
import { createProjectValidator } from "./projects.controller.js";

function violations(result: { readonly ok: boolean; readonly error?: { readonly fields: readonly { readonly field: string }[] } }): readonly string[] {
  return (result.error?.fields ?? []).map((field) => field.field).sort();
}

describe("WIN-267 R1 — reading a request body", () => {
  it("refuses anything that is not a JSON object, including an array", () => {
    // `typeof [] === "object"` and `[] !== null`, so the obvious check accepts an
    // array and then reports every field as missing — a message about the wrong
    // problem entirely.
    expect(jsonBody([]).ok).toBe(false);
    expect(jsonBody(null).ok).toBe(false);
    expect(jsonBody("{}").ok).toBe(false);
    expect(jsonBody({}).ok).toBe(true);
  });

  it("reports EVERY missing field, not the first", () => {
    const outcome = createProjectValidator({});
    expect(outcome.ok).toBe(false);
    expect(violations(outcome)).toEqual([
      "body.environmentName",
      "body.environmentSlug",
      "body.name",
      "body.organizationId",
      "body.slug",
    ]);
  });

  it("separates a missing field from one of the wrong type", () => {
    const outcome = createOrganizationValidator({ name: 42, slug: undefined });
    expect(outcome.ok).toBe(false);
    const codes = (outcome.ok ? [] : outcome.error.fields).map((field) => `${field.field}:${field.code}`).sort();
    expect(codes).toEqual(["body.name:not_a_string", "body.slug:required"]);
  });

  it("passes a value the DOMAIN will refuse straight through", () => {
    // THE RULE THIS TRANCHE IS MOST AT RISK OF BREAKING. `"  "` is not a valid
    // organization name and `"Not A Slug"` is not a slug — and both are strings,
    // so both must reach the use case, which owns the grammar. A transport that
    // refused them here would answer TRANSPORT_REQUEST_INVALID for something
    // `tenancy` has its own code for, and would drift the day the grammar moved.
    const outcome = createOrganizationValidator({ name: "  ", slug: "Not A Slug" });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.value : null).toEqual({ name: "  ", slug: "Not A Slug" });
  });

  it("does not trim, default or otherwise edit what the caller sent", () => {
    const outcome = exchangeSessionValidator({ token: "  spaced  " });
    expect(outcome.ok ? outcome.value.token : null).toBe("  spaced  ");
  });
});

describe("WIN-267 R1 — pagination the contract does and does not have", () => {
  it("refuses a page of an unpaged collection, naming both parameters", () => {
    expect(refuseUnpagedQuery({}).ok).toBe(true);
    const outcome = refuseUnpagedQuery({ limit: "5", cursor: "abc" });
    expect(outcome.ok).toBe(false);
    expect(violations(outcome)).toEqual(["query.cursor", "query.limit"]);
  });

  it("reports the whole set as one page, with the count it actually took", () => {
    expect(wholeCollection([1, 2, 3])).toEqual({
      rows: [1, 2, 3],
      cursor: null,
      limit: 3,
      nextCursor: null,
      total: 3,
    });
    // `total: 0` and NOT an absent total: every row was returned, so zero is a
    // count that was taken. `PageBlock.total` absent means "not counted".
    expect(wholeCollection([]).total).toBe(0);
  });

  it("refuses a cursor that decodes to something this service did not issue", () => {
    const complaints: FieldViolation[] = [];
    expect(offsetInCursor(encodeCursor({ offset: 25 }), complaints)).toBe(25);
    expect(complaints).toEqual([]);
    // Well-formed base64url JSON, wrong shape. Treating it as offset zero is how
    // a client paging a directory quietly re-reads page one forever.
    expect(offsetInCursor(encodeCursor({ page: 2 }), complaints)).toBe(0);
    expect(offsetInCursor(encodeCursor({ offset: -1 }), complaints)).toBe(0);
    expect(offsetInCursor(encodeCursor({ offset: 1.5 }), complaints)).toBe(0);
    expect(complaints).toHaveLength(3);
  });

  it("derives the next cursor from the CONTRACT's hasMore, never from arithmetic", () => {
    // The two would agree today and could disagree tomorrow — the store's total
    // is the only thing that knows whether another row exists.
    expect(nextCursorFor({ users: [], total: 100, limit: 25, offset: 0, hasMore: true })).toBe(
      encodeCursor({ offset: 25 }),
    );
    expect(nextCursorFor({ users: [], total: 100, limit: 25, offset: 75, hasMore: false })).toBeNull();
    // The arithmetic says there IS more; the contract says there is not, and the
    // contract wins. A route that recomputed would hand out a cursor to nothing.
    expect(nextCursorFor({ users: [], total: 100, limit: 25, offset: 0, hasMore: false })).toBeNull();
  });

  it("hands the end-user filters to the contract untouched", () => {
    const outcome = endUserQueryValidator({ status: "banished", search: "  x  ", limit: "10" });
    expect(outcome.ok).toBe(true);
    // `banished` is not a status `listEndUsers` accepts, and that is ITS refusal
    // to make: the contract documents "an unknown status" as a REFUSAL rather
    // than a correction, so a transport that filtered it would answer the wrong
    // code and a transport that dropped it would silently widen the query.
    expect(outcome.ok ? outcome.value : null).toEqual({
      offset: 0,
      limit: 10,
      status: "banished",
      search: "  x  ",
    });
  });

  it("reports a bad limit and a bad cursor in one answer", () => {
    const outcome = endUserQueryValidator({ limit: "0", cursor: "" });
    expect(outcome.ok).toBe(false);
    expect(violations(outcome)).toEqual(["query.cursor", "query.limit"]);
  });
});

describe("WIN-267 R1 — the cookie the BFF writes is the contract's", () => {
  const identityAccess = createIdentityAccessService(testPorts());

  it("renders every attribute the contract decided, and invents none", () => {
    const directive = identityAccess.issueSessionCookie({
      token: "raw-session-token",
      sessionExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      secure: false,
    });
    expect(directive.ok, JSON.stringify(directive)).toBe(true);
    if (!directive.ok) return;
    const header = serializeSetCookie(directive.value);
    // THE NAME COMES FROM THE DOMAIN. Over a non-TLS transport the `__Host-`
    // prefix would make the cookie undeliverable, and the contract picks the
    // unprefixed name for exactly that reason.
    expect(header.startsWith(`${directive.value.shape.name}=`)).toBe(true);
    expect(header).toContain("HttpOnly");
    expect(header).toContain(`Path=${directive.value.shape.path}`);
    expect(header).toContain(`Max-Age=${String(directive.value.maxAgeSeconds)}`);
    expect(header).not.toContain("Secure");
    expect(header).not.toContain("Domain");
  });

  it("carries Secure and the __Host- prefix on a TLS install, because the contract does", () => {
    const directive = identityAccess.issueSessionCookie({
      token: "raw-session-token",
      sessionExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      secure: true,
    });
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    const header = serializeSetCookie(directive.value);
    expect(header.startsWith("__Host-")).toBe(true);
    expect(header).toContain("Secure");
    // RFC 6265bis §4.1.3.2 forbids `Domain` on a `__Host-` cookie, and the
    // directive's `domain` is typed `null` so this branch cannot exist.
    expect(header).not.toContain("Domain");
  });

  it("clears with an empty value and a zero lifetime", () => {
    const directive = identityAccess.clearSessionCookie({ secure: false });
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    const header = serializeSetCookie(directive.value);
    expect(header).toContain("=;");
    expect(header).toContain("Max-Age=0");
  });

  it("asks the CONTRACT for the name on every request, and gets a different one over TLS", () => {
    // THE MUTATION THIS KILLS is a hardcoded cookie name in the guard. Over plain
    // HTTP the unprefixed name is what a hardcoded string would say, so the
    // integration suite cannot see the difference; only the TLS branch can, and
    // `__Host-` is not a name a transport is entitled to know.
    const insecure = { headers: { cookie: "platos_operator_session=plain" } };
    const secure = {
      headers: { cookie: "__Host-platos_operator_session=tls" },
      secure: true,
    };
    expect(presentedOperatorToken(identityAccess, insecure)).toBe("plain");
    expect(presentedOperatorToken(identityAccess, secure)).toBe("tls");
    // And each name is invisible to the other transport, which is what makes the
    // pair a measurement rather than two independent assertions.
    expect(presentedOperatorToken(identityAccess, { headers: insecure.headers, secure: true })).toBeNull();
    expect(presentedOperatorToken(identityAccess, { headers: secure.headers })).toBeNull();
  });

  it("falls back to the Authorization header, which the contract's own input documents", () => {
    expect(
      presentedOperatorToken(identityAccess, { headers: { authorization: "Bearer header-token" } }),
    ).toBe("header-token");
    // The cookie wins when both are present: a browser that holds a session and
    // a caller that pasted a token are two callers, and the browser is the one
    // this transport is for.
    expect(
      presentedOperatorToken(identityAccess, {
        headers: { cookie: "platos_operator_session=cookie-token", authorization: "Bearer header-token" },
      }),
    ).toBe("cookie-token");
  });

  it("finds the cookie by exact name among others", () => {
    const request = { headers: { cookie: "a=1; platos_operator_session=tok%20en; b=2" } };
    expect(readCookie(request, "platos_operator_session")).toBe("tok en");
    expect(readCookie(request, "platos_operator")).toBeNull();
    expect(readCookie({ headers: {} }, "platos_operator_session")).toBeNull();
  });
});

describe("WIN-267 W3 — a sign-out that could not end the session says so", () => {
  /**
   * A REAL `IdentityAccessContract` with ONE method replaced.
   *
   * Everything the handler does apart from the revocation — asking for the cookie
   * name, minting the clear directive, handing it back to `verifySessionCookie` —
   * runs against `createIdentityAccessService`, so this measures the handler's
   * branch and not a contract invented for the occasion.
   */
  function signOutAgainst(refusal: DomainError): {
    readonly run: () => Promise<void>;
    readonly written: readonly string[];
  } {
    const identityAccess: IdentityAccessContract = {
      ...createIdentityAccessService(testPorts()),
      revokeOperatorSession: () => Promise.resolve(err(refusal)),
    };
    const written: string[] = [];
    const controller = new BffSessionController({
      app: { contexts: { identityAccess } } as unknown as AppModule,
    });
    return {
      written,
      run: () =>
        controller.signOut({ headers: {} }, { setHeader: (_name, value) => written.push(value) }),
    };
  }

  /** A code the CONTRACT publishes, never one invented here. */
  function published(code: (typeof IDENTITY_ACCESS_ERROR_CODES)[number]): string {
    if (!IDENTITY_ACCESS_ERROR_CODES.includes(code)) throw new Error(`${code} is not published`);
    return code;
  }

  it("RAISES when the store could not be reached, and writes no cookie", async () => {
    // THE WHOLE POINT OF THE ORDER. If the header went out first, or if every
    // refusal were swallowed, this caller would be told 204 — "you are signed
    // out" — over a session that is still live because nothing could end it. The
    // branch is on the kernel CATEGORY rather than on a list of codes copied into
    // the transport, so a new way for the store to be unreachable is handled
    // without a transport edit.
    const handler = signOutAgainst(
      domainError(published("IDENTITY_STORE_UNAVAILABLE"), "unavailable", "Identity store is unavailable", {
        retryAfterSeconds: 1,
      }),
    );
    const thrown = await handler.run().catch((error: unknown) => error);
    expect(domainErrorOf(thrown)?.code).toBe("IDENTITY_STORE_UNAVAILABLE");
    expect(handler.written, "a sign-out that did not happen must not clear the browser").toEqual([]);
  });

  it("CLEARS the browser anyway when there was simply nothing left to end", async () => {
    // The other side of the same branch, and the property the route had before
    // W3: a browser holding a dead credential is the one that most needs it
    // cleared. Every `unauthenticated` refusal — no token, no such session,
    // already ended — reaches here.
    for (const code of ["UNAUTHENTICATED", "SESSION_REVOKED"] as const) {
      const handler = signOutAgainst(domainError(published(code), "unauthenticated", "refused"));
      await handler.run();
      expect(handler.written, code).toHaveLength(1);
      expect(String(handler.written[0]), code).toContain("Max-Age=0");
    }
  });
});

describe("WIN-267 R1 — the finding that no V1 REST route could spend an authentication budget, REVISITED", () => {
  it("publishes exactly these methods, and the magic-link start is now the one that spends LOGIN", async () => {
    const identityAccess = createIdentityAccessService(testPorts());
    const methods = Object.keys(identityAccess)
      .filter((key) => typeof (identityAccess as unknown as Record<string, unknown>)[key] === "function")
      .sort();

    // THE WHOLE PUBLISHED SURFACE, PINNED, read off a REAL service object so it
    // fails the day the contract gains or loses a method — which is the day the
    // finding below must be revisited rather than inherited. It went red for
    // `revokeOperatorSession` (W3), for `mintBearerCredential` (M4.2 P1) and for
    // `listBearerCredentials` + `revokeBearerCredential` (M4.2), and each time the
    // answer was that the new method spends no pre-authentication budget.
    //
    // IT WENT RED A FIFTH TIME FOR D20 (2026-09-15), AND THIS TIME THE ANSWER IS
    // YES. `startMagicLinkLogin` and `completeMagicLinkLogin` are published, the
    // start spends the LOGIN budget, and `POST /api/v1/bff/magic-link` reaches it —
    // so RATE_LIMITED, and under D3 RATE_LIMIT_FAILED_CLOSED, CAN now truthfully
    // reach this surface. The finding is withdrawn for LOGIN. For INVITE_ACCEPT it
    // is withdrawn by the next case, which measures the accept route spending it;
    // for MFA_VERIFY it stands, because that performer is still unpublished.
    expect(methods).toEqual([
      "authenticateBearer",
      "authenticateOperator",
      "clearSessionCookie",
      "completeMagicLinkLogin",
      "consumeRateLimit",
      "describeSessionCookie",
      "issueSessionCookie",
      "listBearerCredentials",
      "listEndUsers",
      "mintBearerCredential",
      "revokeBearerCredential",
      "revokeOperatorSession",
      "rotateSessionCookie",
      "startMagicLinkLogin",
      "verifySessionCookie",
    ]);

    // LOGIN IS SPENT THROUGH THE PUBLISHED METHOD — measured, not asserted: the
    // budget runs out and the refusal is the limiter's own code.
    const ports = testPorts();
    const published = createIdentityAccessService(ports);
    let refusal: DomainError | null = null;
    for (let request = 0; request < 20 && refusal === null; request += 1) {
      const started = await published.startMagicLinkLogin({ email: "operator@example.com" });
      if (!started.ok) refusal = started.error;
    }
    expect(refusal?.code).toBe("RATE_LIMITED");

    // AND THE PERFORMERS THAT STILL HAVE NO PUBLISHED METHOD — ON EITHER CONTRACT.
    // This guard once listed `acceptInvitation` against identity-access alone, and
    // it went on passing after the method was published on TENANCY: a guard scoped
    // to one contract cannot see a performer that moved to another. So both
    // published surfaces are read off real service objects.
    const tenancyMethods = publishedMethods(createTenancyService(createTenancyFixture().dependencies));
    for (const performer of ["verifyMfaForSession", "beginTotpEnrolment"]) {
      expect(methods, `${performer} is now published — revisit the MFA_VERIFY finding`).not.toContain(performer);
      expect(tenancyMethods, `${performer} is now published — revisit the MFA_VERIFY finding`).not.toContain(performer);
    }
  });

  it("INVITE_ACCEPT: `acceptInvitation` IS published, on tenancy, and its route spends the budget before tenancy sees a token", async () => {
    // THE FINDING, WITHDRAWN FOR INVITE_ACCEPT BY MEASUREMENT. The method is
    // tenancy's, not identity-access's — which is exactly where the guard above
    // used not to look.
    const tenancy = createTenancyService(createTenancyFixture().dependencies);
    expect(publishedMethods(tenancy)).toContain("acceptInvitation");
    expect(publishedMethods(createIdentityAccessService(testPorts()))).not.toContain("acceptInvitation");

    // THE ROUTE, against the REAL limiter behind identity-access's published
    // `consumeRateLimit` and the REAL tenancy use case. Only authentication is
    // stood in for, because no session exists in memory to authenticate.
    let reached = 0;
    let actor = "operator-guessing-tokens";
    const identityAccess: IdentityAccessContract = {
      ...createIdentityAccessService(testPorts()),
      authenticateOperator: () =>
        Promise.resolve(
          ok({
            sessionId: "session-1",
            actorUserId: actor,
            effectiveUserId: actor,
            email: "guesser@example.com",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            mfaVerifiedAt: null,
            impersonating: null,
          }),
        ),
    };
    const controller = new InvitationsController({
      app: {
        contexts: {
          identityAccess,
          tenancy: {
            ...tenancy,
            acceptInvitation: (request: Parameters<typeof tenancy.acceptInvitation>[0]) => {
              reached += 1;
              return tenancy.acceptInvitation(request);
            },
          },
        },
      } as unknown as AppModule,
    });
    const present = async (): Promise<string> => {
      const thrown = await controller.accept({ headers: {} }, { token: "plt_inv_a-guess" }).catch((error: unknown) => error);
      return domainErrorOf(thrown)?.code ?? "(accepted)";
    };

    let admitted = 0;
    let refusal: string | null = null;
    for (let request = 0; request < 21 && refusal === null; request += 1) {
      const code = await present();
      if (code === "RATE_LIMITED") refusal = code;
      else admitted += 1;
    }
    expect(refusal, "INVITE_ACCEPT must refuse a guesser within twenty-one requests").toBe("RATE_LIMITED");
    expect(admitted).toBeGreaterThan(0);
    // SPENT FIRST: every request tenancy saw was an admitted one, and the refused
    // request never reached the token lookup.
    expect(reached).toBe(admitted);

    // THE BUCKET IS THE ACTOR: another human is not refused by this one's guesses.
    actor = "a-different-operator";
    expect(await present()).not.toBe("RATE_LIMITED");
    expect(reached).toBe(admitted + 1);
  });
});

/** The method names a real service object publishes, sorted. */
function publishedMethods(service: object): readonly string[] {
  return Object.keys(service)
    .filter((key) => typeof (service as Record<string, unknown>)[key] === "function")
    .sort();
}
