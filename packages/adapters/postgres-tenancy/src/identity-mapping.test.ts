// The pure half of the identity-access adapter: scope assembly, enum refusals
// and the four write guards.
//
// It runs with no database and no container, which is the point — every
// decision here is a total function of its arguments, so it can be exercised
// exhaustively rather than through whatever rows a fixture happens to contain.
// The half that CANNOT be tested this way is in the `.integration.test.ts`
// suites and is asserted only there.

import { describe, expect, test } from "vitest";

import {
  IdentityWriteRefused,
  EMAIL_NOT_NORMALISED,
  ROTATION_OVERLAP_INVALID,
  requireDigest,
  requireNormalisedEmail,
  requirePositiveDuration,
  requireTotpShape,
  TOKEN_HASH_MALFORMED,
  TOTP_SHAPE_INVALID,
} from "./identity-guards.js";
import {
  INCONSISTENT_AUTHORIZATION_SCOPE,
  readAuthorizationScope,
  readIdentityProvider,
  readIdentityTier,
  UNKNOWN_AUTHORIZATION_SCOPE_KIND,
  UNKNOWN_IDENTITY_PRINCIPAL_TIER,
  UNKNOWN_IDENTITY_PROVIDER,
  UNRESOLVED_SCOPE_ANCESTRY,
  writeAuthorizationScope,
} from "./identity-mapping.js";
import { UnreadableRowError } from "./mapping.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";

function refusalCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UnreadableRowError || error instanceof IdentityWriteRefused) {
      return error.code;
    }
    return `unexpected: ${String(error)}`;
  }
  return "no refusal";
}

describe("enum columns are validated, not cast", () => {
  test("a known provider reads back", () => {
    expect(readIdentityProvider("GITHUB")).toBe("GITHUB");
    expect(readIdentityProvider("MAGIC_LINK")).toBe("MAGIC_LINK");
  });

  test("a provider this binary has not heard of is refused under its own code", () => {
    expect(refusalCode(() => readIdentityProvider("SAML"))).toBe(UNKNOWN_IDENTITY_PROVIDER);
  });

  test("a tier this binary has not heard of is refused under a DIFFERENT code", () => {
    expect(readIdentityTier("EndUserSession.tier", "END_USER")).toBe("END_USER");
    expect(refusalCode(() => readIdentityTier("EndUserSession.tier", "SERVICE"))).toBe(
      UNKNOWN_IDENTITY_PRINCIPAL_TIER,
    );
    // The two codes are distinct on purpose: an unrecognised provider and an
    // unrecognised tier are different operational events, and a shared code
    // would make them indistinguishable in a log.
    expect(UNKNOWN_IDENTITY_PROVIDER).not.toBe(UNKNOWN_IDENTITY_PRINCIPAL_TIER);
  });
});

describe("a scope is assembled from four columns and the ancestors they omit", () => {
  test("GLOBAL carries no tenant id", () => {
    expect(
      readAuthorizationScope({
        scopeKind: "GLOBAL",
        organizationId: null,
        projectId: null,
        environmentId: null,
      }),
    ).toEqual({ kind: "GLOBAL" });
  });

  test("ORGANIZATION needs no ancestry", () => {
    expect(
      readAuthorizationScope({
        scopeKind: "ORGANIZATION",
        organizationId: ORG,
        projectId: null,
        environmentId: null,
      }),
    ).toEqual({
      kind: "ORGANIZATION",
      tenant: { level: "organization", organizationId: ORG },
    });
  });

  test("PROJECT resolves the organization the ROW DOES NOT CARRY", () => {
    // The migrations' `*_scope_shape_check` forbids `organizationId` being set
    // on a project-scoped row, and the kernel's `ProjectScope` requires it. This
    // is the whole reason the reads select the project's organization alongside
    // the row.
    expect(
      readAuthorizationScope(
        { scopeKind: "PROJECT", organizationId: null, projectId: PROJECT, environmentId: null },
        { projectOrganizationId: ORG },
      ),
    ).toEqual({
      kind: "PROJECT",
      tenant: { level: "project", organizationId: ORG, projectId: PROJECT },
    });
  });

  test("ENVIRONMENT resolves two levels", () => {
    expect(
      readAuthorizationScope(
        {
          scopeKind: "ENVIRONMENT",
          organizationId: null,
          projectId: null,
          environmentId: ENVIRONMENT,
        },
        { environmentProjectId: PROJECT, environmentOrganizationId: ORG },
      ),
    ).toEqual({
      kind: "ENVIRONMENT",
      tenant: {
        level: "environment",
        organizationId: ORG,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
      },
    });
  });

  test("a scopeKind outside the enum is refused", () => {
    expect(
      refusalCode(() =>
        readAuthorizationScope({
          scopeKind: "TEAM",
          organizationId: null,
          projectId: null,
          environmentId: null,
        }),
      ),
    ).toBe(UNKNOWN_AUTHORIZATION_SCOPE_KIND);
  });

  test("a kind whose id columns contradict it is refused under a different code", () => {
    // Two ids set where the shape check permits one.
    expect(
      refusalCode(() =>
        readAuthorizationScope({
          scopeKind: "PROJECT",
          organizationId: ORG,
          projectId: PROJECT,
          environmentId: null,
        }),
      ),
    ).toBe(INCONSISTENT_AUTHORIZATION_SCOPE);
    // GLOBAL with a tenant id set.
    expect(
      refusalCode(() =>
        readAuthorizationScope({
          scopeKind: "GLOBAL",
          organizationId: ORG,
          projectId: null,
          environmentId: null,
        }),
      ),
    ).toBe(INCONSISTENT_AUTHORIZATION_SCOPE);
    // A kind with NO id set at all.
    expect(
      refusalCode(() =>
        readAuthorizationScope({
          scopeKind: "ENVIRONMENT",
          organizationId: null,
          projectId: null,
          environmentId: null,
        }),
      ),
    ).toBe(INCONSISTENT_AUTHORIZATION_SCOPE);
  });

  test("a scoped row read without its ancestry is refused, not silently widened", () => {
    // The dangerous alternative is inventing an organization id, or falling
    // back to an organization scope. Either would hand `authorizes()` a grant
    // that reaches more than the row says.
    expect(
      refusalCode(() =>
        readAuthorizationScope({
          scopeKind: "PROJECT",
          organizationId: null,
          projectId: PROJECT,
          environmentId: null,
        }),
      ),
    ).toBe(UNRESOLVED_SCOPE_ANCESTRY);
    expect(
      refusalCode(() =>
        readAuthorizationScope(
          {
            scopeKind: "ENVIRONMENT",
            organizationId: null,
            projectId: null,
            environmentId: ENVIRONMENT,
          },
          { environmentProjectId: PROJECT },
        ),
      ),
    ).toBe(UNRESOLVED_SCOPE_ANCESTRY);
  });

  test("writing drops the ancestry the shape check forbids, and reading restores it", () => {
    const scope = readAuthorizationScope(
      { scopeKind: "PROJECT", organizationId: null, projectId: PROJECT, environmentId: null },
      { projectOrganizationId: ORG },
    );
    const columns = writeAuthorizationScope(scope);
    expect(columns).toEqual({
      scopeKind: "PROJECT",
      organizationId: null,
      projectId: PROJECT,
      environmentId: null,
    });
    expect(readAuthorizationScope(columns, { projectOrganizationId: ORG })).toEqual(scope);
  });

  test("every scope kind round-trips", () => {
    const cases = [
      { scopeKind: "GLOBAL", organizationId: null, projectId: null, environmentId: null },
      { scopeKind: "ORGANIZATION", organizationId: ORG, projectId: null, environmentId: null },
      { scopeKind: "PROJECT", organizationId: null, projectId: PROJECT, environmentId: null },
      {
        scopeKind: "ENVIRONMENT",
        organizationId: null,
        projectId: null,
        environmentId: ENVIRONMENT,
      },
    ] as const;
    const ancestry = {
      projectOrganizationId: ORG,
      environmentProjectId: PROJECT,
      environmentOrganizationId: ORG,
    };
    for (const columns of cases) {
      const scope = readAuthorizationScope(columns, ancestry);
      expect(writeAuthorizationScope(scope)).toEqual(columns);
    }
  });
});

describe("the migration-only write invariants, restated as named refusals", () => {
  const digest = "a1".repeat(32);

  test("a 64-lowercase-hex digest passes and everything else is refused", () => {
    expect(requireDigest("OperatorSession.tokenHash", digest)).toBe(digest);
    // The exact value that would pass every unit test in the tree and be
    // refused by PostgreSQL. This is tranche 1's finding, kept.
    expect(refusalCode(() => requireDigest("OperatorSession.tokenHash", "session-token-1"))).toBe(
      TOKEN_HASH_MALFORMED,
    );
    expect(refusalCode(() => requireDigest("x", "A1".repeat(32)))).toBe(TOKEN_HASH_MALFORMED);
    expect(refusalCode(() => requireDigest("x", "a1".repeat(31)))).toBe(TOKEN_HASH_MALFORMED);
    expect(refusalCode(() => requireDigest("x", `${"a1".repeat(32)}0`))).toBe(
      TOKEN_HASH_MALFORMED,
    );
    expect(refusalCode(() => requireDigest("x", ""))).toBe(TOKEN_HASH_MALFORMED);
  });

  test("an address must already be lower(btrim(...)) of itself", () => {
    expect(requireNormalisedEmail("User.email", "ada@example.test")).toBe("ada@example.test");
    expect(refusalCode(() => requireNormalisedEmail("User.email", "Ada@Example.test"))).toBe(
      EMAIL_NOT_NORMALISED,
    );
    expect(refusalCode(() => requireNormalisedEmail("User.email", " ada@example.test"))).toBe(
      EMAIL_NOT_NORMALISED,
    );
  });

  test("a TOTP row is fully unenrolled or fully enrolled, and its pending half agrees", () => {
    expect(() =>
      requireTotpShape({
        encryptedSecret: null,
        enabledAt: null,
        lastUsedCounter: null,
        pendingEncryptedSecret: null,
        pendingExpiresAt: null,
      }),
    ).not.toThrow();
    expect(() =>
      requireTotpShape({
        encryptedSecret: "envelope",
        enabledAt: new Date(0),
        lastUsedCounter: 3n,
        pendingEncryptedSecret: null,
        pendingExpiresAt: null,
      }),
    ).not.toThrow();
    // Enrolled with nothing to verify against — the row that would make
    // `verifyMfa` demand a second factor it cannot check.
    expect(
      refusalCode(() =>
        requireTotpShape({
          encryptedSecret: null,
          enabledAt: new Date(0),
          lastUsedCounter: null,
          pendingEncryptedSecret: null,
          pendingExpiresAt: null,
        }),
      ),
    ).toBe(TOTP_SHAPE_INVALID);
    // A pending secret with no expiry: an enrolment window that never closes.
    expect(
      refusalCode(() =>
        requireTotpShape({
          encryptedSecret: null,
          enabledAt: null,
          lastUsedCounter: null,
          pendingEncryptedSecret: "envelope",
          pendingExpiresAt: null,
        }),
      ),
    ).toBe(TOTP_SHAPE_INVALID);
  });

  test("a rotation overlap is a positive whole number of milliseconds", () => {
    expect(requirePositiveDuration("overlapMs", 600_000)).toBe(600_000);
    expect(refusalCode(() => requirePositiveDuration("overlapMs", 0))).toBe(
      ROTATION_OVERLAP_INVALID,
    );
    expect(refusalCode(() => requirePositiveDuration("overlapMs", -1))).toBe(
      ROTATION_OVERLAP_INVALID,
    );
    expect(refusalCode(() => requirePositiveDuration("overlapMs", 1.5))).toBe(
      ROTATION_OVERLAP_INVALID,
    );
  });

  test("the four write refusals carry four distinct codes", () => {
    const codes = new Set([
      TOKEN_HASH_MALFORMED,
      EMAIL_NOT_NORMALISED,
      TOTP_SHAPE_INVALID,
      ROTATION_OVERLAP_INVALID,
    ]);
    expect(codes.size).toBe(4);
  });
});
