import { asIdentifier, environmentScope } from "@platos/kernel";
import { isMintedAuthorization } from "@platos/context-secrets";
import { isEnvironmentOperatorAuthorization, requireAuthorization } from "@platos/context-tenancy";
import { describe, expect, it } from "vitest";

import {
  requireAccess,
  runtimeScope,
  vaultGrantFor,
  verifyOperator,
  verifyOperatorGrant,
  verifyRuntimeGrant,
} from "./authorization.js";
import { buildProvidersTestContext, otherEnvironment, testEnvironmentScope } from "./testing/index.js";

describe("the real published check cannot be satisfied by a literal", () => {
  // This is the property the whole seam rests on, and it is pinned HERE — in the
  // package that depends on it — rather than only in the package that provides
  // it. If tenancy ever weakened its check to a shape test, this fails.
  it("rejects a hand-written value that is structurally perfect", () => {
    const forged = Object.freeze({
      principalType: "operator",
      tier: "OPERATOR",
      access: "secret:mutate",
      scope: testEnvironmentScope(),
      actorUserId: asIdentifier("operator-1"),
      effectiveUserId: asIdentifier("operator-1"),
      organizationRole: "ADMIN",
      projectRole: null,
    });
    expect(isEnvironmentOperatorAuthorization(forged)).toBe(false);
    expect(requireAuthorization(forged).ok).toBe(false);
  });

  it("rejects nothing at all", () => {
    for (const value of [null, undefined, "grant", 42, {}]) {
      expect(requireAuthorization(value).ok).toBe(false);
    }
  });
});

describe("asking tenancy", () => {
  it("accepts a grant tenancy issued and refuses one it did not", () => {
    const context = buildProvidersTestContext();
    expect(verifyOperator(context.dependencies, context.tenancy.grant()).ok).toBe(true);
    expect(verifyOperator(context.dependencies, { access: "secret:mutate" }).ok).toBe(false);
  });

  it("refuses a genuine grant that is for a different environment", () => {
    const context = buildProvidersTestContext();
    const elsewhere = context.tenancy.grant("secret:mutate", otherEnvironment());
    const denied = verifyOperatorGrant(context.dependencies, elsewhere, context.scope);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_SCOPE_MISMATCH");
  });

  it("accepts a genuine grant for the environment it names", () => {
    const context = buildProvidersTestContext();
    expect(verifyOperatorGrant(context.dependencies, context.tenancy.grant(), context.scope).ok).toBe(
      true,
    );
  });
});

describe("access levels", () => {
  it("lets metadata read and refuses it a mutation", () => {
    const context = buildProvidersTestContext();
    const metadata = context.tenancy.grant("metadata");
    expect(requireAccess(metadata, "metadata").ok).toBe(true);
    expect(requireAccess(metadata, "secret:mutate").ok).toBe(false);
  });

  it("lets secret:mutate do both", () => {
    const context = buildProvidersTestContext();
    const mutate = context.tenancy.grant("secret:mutate");
    expect(requireAccess(mutate, "metadata").ok).toBe(true);
    expect(requireAccess(mutate, "secret:mutate").ok).toBe(true);
  });
});

describe("deriving the vault's grant", () => {
  it("produces a GENUINELY minted secrets authorization", () => {
    const context = buildProvidersTestContext();
    const derived = vaultGrantFor(context.tenancy.grant());
    // Identity against secrets' own mint register — not shape.
    expect(isMintedAuthorization(derived)).toBe(true);
  });

  it("carries the ancestry from the tenancy grant's own re-derived scope", () => {
    const context = buildProvidersTestContext();
    const derived = vaultGrantFor(context.tenancy.grant("secret:mutate", otherEnvironment()));
    expect(derived.organizationId).toBe("org-2");
    expect(derived.projectId).toBe("proj-2");
    expect(derived.environmentId).toBe("env-2");
  });

  it("maps the access level one-to-one, never widening it", () => {
    const context = buildProvidersTestContext();
    expect(vaultGrantFor(context.tenancy.grant("metadata")).access).toBe("metadata");
    expect(vaultGrantFor(context.tenancy.grant("secret:mutate")).access).toBe("secret:mutate");
  });

  it("preserves who really acted", () => {
    const context = buildProvidersTestContext();
    const derived = vaultGrantFor(context.tenancy.grant());
    expect(derived.actorUserId).toBe("operator-1");
    expect(derived.effectiveUserId).toBe("operator-1");
  });

  it("is an OPERATOR grant, which the vault refuses material reads to", async () => {
    const context = buildProvidersTestContext();
    const credential = context.secrets.seed({
      name: "OPENAI_API_KEY",
      provider: "openai",
      plaintext: "sk-live",
    });
    const denied = await context.dependencies.secrets.readSecret({
      authorization: vaultGrantFor(context.tenancy.grant()),
      credentialId: credential.id,
    });
    expect(denied.ok).toBe(false);
  });
});

describe("the runtime grant", () => {
  it("accepts the environment it was minted for and refuses any other", () => {
    const context = buildProvidersTestContext();
    const grant = context.secrets.runtimeGrant();
    expect(verifyRuntimeGrant(grant, context.scope).ok).toBe(true);
    expect(verifyRuntimeGrant(grant, otherEnvironment()).ok).toBe(false);
  });

  it("compares the WHOLE chain, not just the leaf", () => {
    const context = buildProvidersTestContext();
    const grant = context.secrets.runtimeGrant();
    const reparented = environmentScope(
      asIdentifier("org-other"),
      asIdentifier("proj-1"),
      asIdentifier("env-1"),
    );
    expect(verifyRuntimeGrant(grant, reparented).ok).toBe(false);
  });

  it("reports the environment it covers as a kernel scope", () => {
    const context = buildProvidersTestContext();
    expect(runtimeScope(context.secrets.runtimeGrant())).toEqual(context.scope);
  });
});
