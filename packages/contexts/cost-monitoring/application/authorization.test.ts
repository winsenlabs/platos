// The seam between this context and tenancy's authorization.
//
// The in-memory double answers from its own register, so most tests here exercise
// the ASK. The last two exercise the REAL published check, so the production
// wiring cannot be sound in the double and unsound at the seam.
import { describe, expect, it } from "vitest";
import { isEnvironmentOperatorAuthorization, requireAuthorization } from "@platos/context-tenancy";

import { authorize, requireAccess, verifyOperator, verifyOperatorGrant } from "./authorization.js";
import { buildCostTestContext, otherEnvironment, testEnvironmentScope } from "./testing/index.js";

describe("asking tenancy", () => {
  it("accepts a grant tenancy issued", () => {
    const context = buildCostTestContext();
    const verified = verifyOperator(context.dependencies, context.tenancy.grant());
    expect(verified.ok).toBe(true);
  });

  it("refuses a hand-written literal with the same SHAPE", () => {
    // Identity, not shape. A value that arrived as data must not be a grant.
    const context = buildCostTestContext();
    const denied = verifyOperator(context.dependencies, {
      principalType: "operator",
      access: "secret:mutate",
      scope: context.scope,
    });
    expect(denied.ok).toBe(false);
  });

  it("refuses a primitive, a null and an absent value", () => {
    const context = buildCostTestContext();
    for (const value of [null, undefined, "grant", 7, true]) {
      expect(verifyOperator(context.dependencies, value).ok).toBe(false);
    }
  });
});

describe("confirming the environment", () => {
  it("accepts a grant for the scope it names", () => {
    const context = buildCostTestContext();
    const verified = verifyOperatorGrant(
      context.dependencies,
      context.tenancy.grant(),
      context.scope,
    );
    expect(verified.ok).toBe(true);
  });

  it("refuses a genuine grant for a DIFFERENT environment", () => {
    // A value that is genuine but for somewhere else is the cross-tenant read
    // this check exists to refuse.
    const context = buildCostTestContext();
    const denied = verifyOperatorGrant(
      context.dependencies,
      context.tenancy.grant("secret:mutate", otherEnvironment()),
      context.scope,
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_SCOPE_MISMATCH");
    expect(denied.error.category).toBe("forbidden");
  });

  it("names both paths in the error, so an operator can see the mismatch", () => {
    const context = buildCostTestContext();
    const denied = verifyOperatorGrant(
      context.dependencies,
      context.tenancy.grant("secret:mutate", otherEnvironment()),
      testEnvironmentScope(),
    );
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.details["expectedPath"]).toBe("org/org-1/proj/proj-1/env/env-1");
    expect(denied.error.details["grantedPath"]).toBe("org/org-2/proj/proj-2/env/env-2");
  });
});

describe("the two access levels", () => {
  it("lets a metadata grant read but not mutate a channel", () => {
    // Writing a channel mints or rotates a credential, even though this context
    // never touches the material. Writing a CAP does not, which is why
    // `configureBudget` authorises at the lower level.
    const context = buildCostTestContext();
    const metadata = context.tenancy.grant("metadata");
    expect(requireAccess(metadata, "metadata").ok).toBe(true);
    expect(requireAccess(metadata, "secret:mutate").ok).toBe(false);
  });

  it("lets a secret-mutating grant do both", () => {
    const context = buildCostTestContext();
    const elevated = context.tenancy.grant("secret:mutate");
    expect(requireAccess(elevated, "metadata").ok).toBe(true);
    expect(requireAccess(elevated, "secret:mutate").ok).toBe(true);
  });

  it("verifies and demands a level in one call, so neither is forgotten", () => {
    const context = buildCostTestContext();
    expect(authorize(context.dependencies, context.tenancy.grant("metadata"), "secret:mutate").ok).toBe(
      false,
    );
    expect(authorize(context.dependencies, {}, "metadata").ok).toBe(false);
    expect(
      authorize(context.dependencies, context.tenancy.grant("secret:mutate"), "secret:mutate").ok,
    ).toBe(true);
  });
});

describe("the REAL published check, not the double's", () => {
  it("rejects a hand-written literal that satisfies the type", () => {
    // The double has its own register; this pins that the production check the
    // composition root actually calls is identity-based too.
    const literal = {
      principalType: "operator",
      tier: "OPERATOR",
      access: "secret:mutate",
      scope: testEnvironmentScope(),
      actorUserId: "operator-1",
      effectiveUserId: "operator-1",
      organizationRole: "ADMIN",
      projectRole: null,
    };
    expect(isEnvironmentOperatorAuthorization(literal)).toBe(false);
    expect(requireAuthorization(literal).ok).toBe(false);
  });

  it("rejects a primitive and a null", () => {
    for (const value of [null, undefined, "grant", 7]) {
      expect(isEnvironmentOperatorAuthorization(value)).toBe(false);
    }
  });
});
