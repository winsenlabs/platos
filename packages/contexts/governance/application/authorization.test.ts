import { requireAuthorization, isEnvironmentOperatorAuthorization } from "@platos/context-tenancy";
import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { EndUserId } from "../domain/index.js";
import { verifyOperator, verifyOperatorGrant, verifyRatingActor } from "./authorization.js";
import { buildGovernanceTestContext, otherEnvironmentScope, testEnvironmentScope } from "./testing/index.js";

const END_USER = asIdentifier<EndUserId>("end-user-1");

describe("verifyOperator", () => {
  it("accepts a grant tenancy actually minted", () => {
    const context = buildGovernanceTestContext();
    const verified = verifyOperator(context.dependencies, context.authorization);
    expect(verified.ok).toBe(true);
  });

  it("REFUSES a hand-written literal shaped like a grant", () => {
    const context = buildGovernanceTestContext();
    const forged = Object.freeze({
      principalType: "operator",
      tier: "OPERATOR",
      access: "metadata",
      scope: context.scope,
      actorUserId: "operator-1",
      effectiveUserId: "operator-1",
      organizationRole: "ADMIN",
      projectRole: null,
    });
    expect(verifyOperator(context.dependencies, forged).ok).toBe(false);
  });

  it("REFUSES a COPY of a genuine grant — identity, not shape", () => {
    const context = buildGovernanceTestContext();
    const copied = Object.freeze({ ...(context.authorization as unknown as Record<string, unknown>) });
    expect(verifyOperator(context.dependencies, copied).ok).toBe(false);
  });

  it("REFUSES null, undefined and a primitive", () => {
    const context = buildGovernanceTestContext();
    expect(verifyOperator(context.dependencies, null).ok).toBe(false);
    expect(verifyOperator(context.dependencies, undefined).ok).toBe(false);
    expect(verifyOperator(context.dependencies, "grant").ok).toBe(false);
  });

  it("takes the environment FROM the grant", () => {
    const context = buildGovernanceTestContext();
    const verified = verifyOperator(context.dependencies, context.authorization);
    expect(verified.ok && verified.value.scope.environmentId).toBe("env-1");
  });
});

describe("the REAL published check, not only this suite's double", () => {
  // The doubles model tenancy's identity register. This pins that the actual
  // published check behaves the same way, so the production wiring cannot be
  // sound in the double and unsound at the seam.
  it("rejects a hand-written literal", () => {
    const forged = Object.freeze({
      principalType: "operator",
      tier: "OPERATOR",
      access: "metadata",
      scope: testEnvironmentScope(),
      actorUserId: "operator-1",
      effectiveUserId: "operator-1",
      organizationRole: "ADMIN",
      projectRole: null,
    });
    expect(isEnvironmentOperatorAuthorization(forged)).toBe(false);
    expect(requireAuthorization(forged).ok).toBe(false);
  });

  it("rejects a plain object and a primitive", () => {
    expect(isEnvironmentOperatorAuthorization({})).toBe(false);
    expect(isEnvironmentOperatorAuthorization("grant")).toBe(false);
    expect(isEnvironmentOperatorAuthorization(null)).toBe(false);
  });
});

describe("verifyOperatorGrant", () => {
  it("accepts a grant for the environment it was asked about", () => {
    const context = buildGovernanceTestContext();
    expect(verifyOperatorGrant(context.dependencies, context.authorization, context.scope).ok).toBe(true);
  });

  it("REFUSES a genuine grant for a DIFFERENT environment", () => {
    const context = buildGovernanceTestContext();
    const other = otherEnvironmentScope();
    const verified = verifyOperatorGrant(context.dependencies, context.authorization, other);
    expect(verified.ok).toBe(false);
    expect(!verified.ok && verified.error.code).toBe("GOVERNANCE_SCOPE_MISMATCH");
  });

  it("names both paths in the refusal, so a log says which was which", () => {
    const context = buildGovernanceTestContext();
    const verified = verifyOperatorGrant(context.dependencies, context.authorization, otherEnvironmentScope());
    expect(!verified.ok && verified.error.details).toEqual({
      expectedPath: "org/org-2/proj/proj-2/env/env-2",
      grantedPath: "org/org-1/proj/proj-1/env/env-1",
    });
  });

  it("REFUSES an unminted grant before it compares scopes at all", () => {
    const context = buildGovernanceTestContext();
    const verified = verifyOperatorGrant(context.dependencies, {}, context.scope);
    expect(!verified.ok && verified.error.code).not.toBe("GOVERNANCE_SCOPE_MISMATCH");
  });
});

describe("verifyRatingActor", () => {
  it("accepts an END USER with a genuine environment grant", () => {
    const context = buildGovernanceTestContext();
    const verified = verifyRatingActor(context.dependencies, context.authorization, {
      kind: "end-user",
      endUserId: END_USER,
    });
    expect(verified.ok && verified.value.endUserId).toBe(END_USER);
  });

  it("REFUSES an OPERATOR actor outright", () => {
    const context = buildGovernanceTestContext();
    const verified = verifyRatingActor(context.dependencies, context.authorization, { kind: "operator" });
    expect(verified.ok).toBe(false);
    expect(!verified.ok && verified.error.code).toBe("GOVERNANCE_RATING_ACTOR_FORBIDDEN");
  });

  it("refuses the OPERATOR before the grant is even verified", () => {
    // Refusing first is what stops an operator probing turn ids: the answer is
    // the same whether or not their grant is any good.
    const context = buildGovernanceTestContext();
    const verified = verifyRatingActor(context.dependencies, {}, { kind: "operator" });
    expect(!verified.ok && verified.error.code).toBe("GOVERNANCE_RATING_ACTOR_FORBIDDEN");
  });

  it("REFUSES an end user whose environment grant is not genuine", () => {
    const context = buildGovernanceTestContext();
    const verified = verifyRatingActor(context.dependencies, {}, { kind: "end-user", endUserId: END_USER });
    expect(verified.ok).toBe(false);
    expect(!verified.ok && verified.error.code).not.toBe("GOVERNANCE_RATING_ACTOR_FORBIDDEN");
  });
});
