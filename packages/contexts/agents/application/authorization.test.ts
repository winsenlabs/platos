import { asIdentifier, environmentScope, type EnvironmentId, type OrganizationId, type ProjectId } from "@platos/kernel";
import { isEnvironmentOperatorAuthorization, requireAuthorization } from "@platos/context-tenancy";
import { describe, expect, it } from "vitest";

import { projectOf, verifyOperator, verifyOperatorGrant } from "./authorization.js";
import { buildAgentsTestContext, testEnvironmentScope } from "./testing/fixtures.js";
import { otherEnvironment } from "./testing/in-memory-peers.js";

describe("verification asks tenancy", () => {
  it("accepts a grant tenancy minted", () => {
    const context = buildAgentsTestContext();
    const verified = verifyOperator(context.dependencies, context.tenancy.grant());
    expect(verified.ok).toBe(true);
  });

  it("refuses a hand-written literal that has the right SHAPE", () => {
    const context = buildAgentsTestContext();
    const forged = {
      principalType: "operator",
      tier: "OPERATOR",
      access: "metadata",
      scope: context.scope,
      actorUserId: "operator-1",
      effectiveUserId: "operator-1",
      organizationRole: "ADMIN",
      projectRole: null,
    };
    expect(verifyOperator(context.dependencies, forged).ok).toBe(false);
  });

  it("refuses a value copied field-by-field out of a genuine grant", () => {
    const context = buildAgentsTestContext();
    const genuine = context.tenancy.grant();
    expect(verifyOperator(context.dependencies, { ...genuine }).ok).toBe(false);
  });

  it("refuses undefined, null and a primitive", () => {
    const context = buildAgentsTestContext();
    for (const value of [undefined, null, "grant", 7, true]) {
      expect(verifyOperator(context.dependencies, value).ok).toBe(false);
    }
  });
});

describe("the REAL published check, not the double", () => {
  // The double recognises what the double issued. This pins that the value it
  // issues would ALSO be refused by tenancy's own register, so the production
  // wiring cannot be sound in this file and unsound at the seam.
  it("refuses a hand-written literal", () => {
    expect(
      isEnvironmentOperatorAuthorization({
        principalType: "operator",
        tier: "OPERATOR",
        access: "metadata",
        scope: testEnvironmentScope(),
        actorUserId: "operator-1",
        effectiveUserId: "operator-1",
        organizationRole: "ADMIN",
        projectRole: null,
      }),
    ).toBe(false);
  });

  it("refuses the double's own grant, which tenancy never minted", () => {
    const context = buildAgentsTestContext();
    expect(isEnvironmentOperatorAuthorization(context.tenancy.grant())).toBe(false);
    expect(requireAuthorization(context.tenancy.grant()).ok).toBe(false);
  });
});

describe("scope confirmation", () => {
  it("accepts a grant for the environment it was asked about", () => {
    const context = buildAgentsTestContext();
    expect(verifyOperatorGrant(context.dependencies, context.tenancy.grant(), context.scope).ok).toBe(true);
  });

  it("refuses a grant minted for a DIFFERENT environment", () => {
    const context = buildAgentsTestContext();
    const elsewhere = otherEnvironment();
    const granted = verifyOperatorGrant(
      context.dependencies,
      context.tenancy.grant("metadata", elsewhere),
      context.scope,
    );
    if (granted.ok) throw new Error("unreachable");
    expect(granted.error.code).toBe("AGENTS_SCOPE_MISMATCH");
    expect(granted.error.category).toBe("forbidden");
  });

  it("refuses a grant for the same environment id under a different project", () => {
    const context = buildAgentsTestContext();
    const reparented = environmentScope(
      asIdentifier<OrganizationId>("org-1"),
      asIdentifier<ProjectId>("proj-9"),
      asIdentifier<EnvironmentId>("env-1"),
    );
    expect(
      verifyOperatorGrant(context.dependencies, context.tenancy.grant("metadata", reparented), context.scope).ok,
    ).toBe(false);
  });

  it("refuses an unminted value before it even compares scopes", () => {
    const context = buildAgentsTestContext();
    const granted = verifyOperatorGrant(context.dependencies, {}, context.scope);
    if (granted.ok) throw new Error("unreachable");
    expect(granted.error.code).not.toBe("AGENTS_SCOPE_MISMATCH");
  });
});

describe("the project comes from the grant", () => {
  it("reads the project off the grant's own re-derived scope", () => {
    const context = buildAgentsTestContext();
    const granted = verifyOperator(context.dependencies, context.tenancy.grant());
    if (!granted.ok) throw new Error("unreachable");
    expect(projectOf(granted.value)).toBe(context.scope.projectId);
  });
});

describe("every operation in this context is metadata-level", () => {
  it("accepts the weaker of tenancy's two levels without narrowing further", () => {
    // Recorded as a finding, not an oversight: the same grant that lets an
    // operator READ this environment's agents lets them REWRITE one, which is
    // the running system's behaviour.
    const context = buildAgentsTestContext();
    expect(verifyOperator(context.dependencies, context.tenancy.grant("metadata")).ok).toBe(true);
    expect(verifyOperator(context.dependencies, context.tenancy.grant("secret:mutate")).ok).toBe(true);
  });
});
