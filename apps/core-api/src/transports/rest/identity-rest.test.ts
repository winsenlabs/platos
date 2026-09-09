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

import type { FieldViolation } from "@platos/kernel";

import {
  createIdentityAccessService,
  testPorts,
} from "@platos/context-identity-access/application/index.js";

import { serializeSetCookie } from "../bff/session.controller.js";
import { exchangeSessionValidator } from "../bff/session.controller.js";
import { BodyReader, jsonBody } from "./body.js";
import { encodeCursor, wholeCollection } from "./envelope.js";
import {
  endUserQueryValidator,
  nextCursorFor,
  offsetInCursor,
} from "./environment-end-users.controller.js";
import { createOrganizationValidator } from "./organizations.controller.js";
import { readCookie } from "./operator.js";
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

  it("finds the cookie by exact name among others", () => {
    const request = { headers: { cookie: "a=1; platos_operator_session=tok%20en; b=2" } };
    expect(readCookie(request, "platos_operator_session")).toBe("tok en");
    expect(readCookie(request, "platos_operator")).toBeNull();
    expect(readCookie({ headers: {} }, "platos_operator_session")).toBeNull();
  });
});

describe("WIN-267 R1 — the finding: no V1 REST route can spend an authentication budget", () => {
  it("publishes a limiter whose three actions have no published performer", () => {
    const identityAccess = createIdentityAccessService(testPorts());
    const methods = Object.keys(identityAccess)
      .filter((key) => typeof (identityAccess as unknown as Record<string, unknown>)[key] === "function")
      .sort();

    // THE WHOLE PUBLISHED SURFACE, PINNED. Not a literal asserted against itself:
    // the left side is read off a REAL service object, so this fails the day the
    // contract gains or loses a method — which is the day somebody must revisit
    // the finding below rather than inherit it.
    expect(methods).toEqual([
      "authenticateBearer",
      "authenticateOperator",
      "clearSessionCookie",
      "consumeRateLimit",
      "describeSessionCookie",
      "issueSessionCookie",
      "listEndUsers",
      "rotateSessionCookie",
      "verifySessionCookie",
    ]);

    // `consumeRateLimit` IS published, so the limiter is reachable. What is not
    // reachable is anything to spend it ON: its actions are LOGIN, INVITE_ACCEPT
    // and MFA_VERIFY, and every use case that performs one of those lives in
    // `application/` behind no contract method. A V1 route may only reach a
    // contract method (`composition-root.mjs` C8 and ADR M0.3 §2), so RATE_LIMITED
    // cannot truthfully reach this surface in R1.
    expect(methods).toContain("consumeRateLimit");
    for (const performer of [
      "startMagicLinkLogin",
      "completeMagicLinkLogin",
      "verifyMfaForSession",
      "beginTotpEnrolment",
      "acceptInvitation",
    ]) {
      expect(methods, `${performer} is now published — revisit the R1 rate-limit finding`).not.toContain(
        performer,
      );
    }
  });
});
