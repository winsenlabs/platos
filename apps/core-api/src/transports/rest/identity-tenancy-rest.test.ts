// WIN-257 T6 — the parts of the identity/tenancy REST remainder that need no
// server: what each new route accepts as a request, and the two readings of a
// session cookie's value (D19).
//
// The behaviour over HTTP, with real PostgreSQL, Redis and an SMTP relay, is in
// `composition/identity-tenancy-rest.integration.test.ts` and
// `composition/magic-link-email.integration.test.ts`. The cookie cases here are
// joined to the REAL Remix library in
// `composition/legacy-session-cookie.integration.test.ts`; what is here is the
// branch table a real cookie would only exercise one arm of.

import { describe, expect, it } from "vitest";

import { completeMagicLinkValidator, startMagicLinkValidator } from "../bff/magic-link.controller.js";
import { serializeSetCookie } from "../bff/session.controller.js";
import { environmentScopeQueryValidator } from "./environment-scope.controller.js";
import { setEnvironmentVariableValidator } from "./environment-variables.controller.js";
import { acceptInvitationValidator, issueInvitationValidator } from "./invitations.controller.js";
import { changeMemberRoleValidator } from "./organization-members.controller.js";
import { presentedOperatorToken } from "./operator.js";
import {
  decodeLegacySessionValue,
  encodeLegacySessionValue,
  sessionTokenFromCookieValue,
} from "./session-cookie-value.js";

import {
  createIdentityAccessService,
  testPorts,
} from "@platos/context-identity-access/application/index.js";

function fields(result: { readonly ok: boolean; readonly error?: { readonly fields: readonly { readonly field: string; readonly code: string }[] } }): string[] {
  return (result.error?.fields ?? []).map((field) => `${field.field}:${field.code}`).sort();
}

describe("D19 — a session cookie's value, in either dialect", () => {
  // `base64(JSON.stringify("abc123tokenvalue"))`, the value the census measured
  // Remix writing for this token.
  const REMIX = "ImFiYzEyM3Rva2VudmFsdWUi";

  it("reads the Remix-encoded value the census measured back to the token", () => {
    expect(decodeLegacySessionValue(REMIX)).toBe("abc123tokenvalue");
    expect(sessionTokenFromCookieValue(REMIX)).toBe("abc123tokenvalue");
  });

  it("round-trips any token through the writer, including characters base64 and JSON must escape", () => {
    for (const token of ["plt_os_abc", "plt_os_+/=", 'plt_os_"quoted"\\', "plt_os_é漢"]) {
      expect(decodeLegacySessionValue(encodeLegacySessionValue(token))).toBe(token);
    }
  });

  it("takes a REAL token raw: `plt_os_` is not base64, so it can never be read as the legacy dialect", () => {
    expect(decodeLegacySessionValue("plt_os_AbCdEf0123456789")).toBeNull();
    expect(sessionTokenFromCookieValue("plt_os_AbCdEf0123456789")).toBe("plt_os_AbCdEf0123456789");
  });

  it("takes base64 that is not a JSON STRING raw — Remix's `{}` fallback, a number, an object", () => {
    for (const value of ["e30=", "MTIz", "eyJhIjoxfQ==", "IiI=", ""]) {
      expect(decodeLegacySessionValue(value), value).toBeNull();
    }
  });

  it("refuses non-canonical base64 rather than decoding it leniently", () => {
    expect(decodeLegacySessionValue("ImFiYzEyM3Rva2VudmFsdWUi=")).toBeNull();
    expect(decodeLegacySessionValue("ImFiYz EyM3Rva2VudmFsdWUi")).toBeNull();
  });

  it("decodes a COOKIE and never the Authorization header", () => {
    const identityAccess = createIdentityAccessService(testPorts());
    expect(
      presentedOperatorToken(identityAccess, { headers: { cookie: `platos_operator_session=${REMIX}` } }),
    ).toBe("abc123tokenvalue");
    expect(presentedOperatorToken(identityAccess, { headers: { authorization: `Bearer ${REMIX}` } })).toBe(REMIX);
  });

  it("writes the Remix dialect into Set-Cookie, and still clears with an empty value", () => {
    const identityAccess = createIdentityAccessService(testPorts());
    const issued = identityAccess.issueSessionCookie({
      token: "plt_os_written",
      sessionExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      secure: false,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const pair = serializeSetCookie(issued.value).split(";")[0] ?? "";
    const value = decodeURIComponent(pair.slice(pair.indexOf("=") + 1));
    expect(value).toBe(encodeLegacySessionValue("plt_os_written"));
    expect(sessionTokenFromCookieValue(value)).toBe("plt_os_written");
    const cleared = identityAccess.clearSessionCookie({ secure: false });
    expect(cleared.ok && serializeSetCookie(cleared.value)).toContain("platos_operator_session=;");
  });
});

describe("what each new route accepts — SHAPE only, every violation at once", () => {
  it("the magic-link pair takes one string each", () => {
    expect(startMagicLinkValidator({ email: "a@b.co" }).ok).toBe(true);
    expect(fields(startMagicLinkValidator({}))).toEqual(["body.email:required"]);
    expect(fields(completeMagicLinkValidator({ token: 5 }))).toEqual(["body.token:not_a_string"]);
    // THE GRAMMAR IS NOT HERE: an address identity-access will refuse passes.
    expect(startMagicLinkValidator({ email: "not an address" }).ok).toBe(true);
  });

  it("a role change takes a string and leaves the enumeration to tenancy", () => {
    expect(changeMemberRoleValidator({ role: "SUPERUSER" }).ok).toBe(true);
    expect(fields(changeMemberRoleValidator({ role: null }))).toEqual(["body.role:required"]);
  });

  it("an invitation takes an email and an optional role, and reports both problems together", () => {
    expect(issueInvitationValidator({ email: "a@b.co" })).toEqual({ ok: true, value: { email: "a@b.co" } });
    expect(fields(issueInvitationValidator({ role: 3 }))).toEqual(["body.email:required", "body.role:not_a_string"]);
    expect(fields(acceptInvitationValidator([]))).toEqual(["body:malformed"]);
  });

  it("a variable write takes a string value and an optional boolean, and nothing else is coerced", () => {
    expect(setEnvironmentVariableValidator({ value: "x", secret: true }).ok).toBe(true);
    expect(fields(setEnvironmentVariableValidator({ value: 1, secret: "yes" }))).toEqual([
      "body.secret:not_a_boolean",
      "body.value:not_a_string",
    ]);
  });

  it("the scope resolver needs all three slugs, once each", () => {
    expect(
      environmentScopeQueryValidator({ organizationSlug: "a", projectSlug: "b", environmentSlug: "c" }).ok,
    ).toBe(true);
    expect(fields(environmentScopeQueryValidator({ organizationSlug: ["a", "a"], projectSlug: "" }))).toEqual([
      "query.environmentSlug:required",
      "query.organizationSlug:repeated",
      "query.projectSlug:required",
    ]);
  });
});
