import { asIdentifier, environmentScope, unwrap } from "@platos/kernel";
import { acceptPlaintext, isMintedAuthorization } from "@platos/context-secrets";
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

describe("the vault double refuses exactly what the real vault refuses", () => {
  // WIN-259. THIS IS THE CASE THAT MAKES `InMemorySecrets.writeOnly` KILLABLE
  // ON ITS OWN, and it is here because the guard's own ledger entry could not
  // name one: every OTHER case in this package reaches the double through a use
  // case, and the use cases now wrap at their own seam, so the double never sees
  // a bare string and a double that accepted one changed nothing measurable.
  //
  // The refusal half is the mutation's target. The ACCEPTANCE half is what
  // stops the pair being an assertion about a value this package controls: the
  // material is minted by `acceptPlaintext`, the ONE mint `secrets` publishes,
  // so the double is being held to recognising exactly what the real vault
  // produces. If `secrets` changed what a write-only value is, this goes red in
  // the package that depends on it rather than only in the package that
  // declares it — the same reason the literal-rejection cases at the top of this
  // file are pinned here and not only in `tenancy`.
  it("refuses a bare string and accepts what acceptPlaintext mints", async () => {
    const context = buildProvidersTestContext();
    const refused = await context.secrets.createCredential({
      name: "BARE",
      provider: "openai",
      plaintext: "sk-live-bare" as never,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.details).toMatchObject({ reason: "secret_input_not_write_only" });

    const admitted = await context.secrets.createCredential({
      name: "MINTED",
      provider: "openai",
      plaintext: unwrap(acceptPlaintext("sk-live-minted")),
    });
    expect(admitted.ok).toBe(true);
  });

  it("refuses a bare string on ROTATION too, not only on creation", async () => {
    const context = buildProvidersTestContext();
    const created = unwrap(
      await context.secrets.createCredential({
        name: "ROTATED",
        provider: "openai",
        plaintext: unwrap(acceptPlaintext("sk-live-one")),
      }),
    );
    const refused = await context.secrets.rotateCredential({
      credentialId: created.id,
      plaintext: "sk-live-two" as never,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.details).toMatchObject({ reason: "secret_input_not_write_only" });
  });

  it("refuses a value that MIMICS material but answers the wrong redaction", async () => {
    // `isSecretMaterial` asks a function to answer with a literal only the
    // `secrets` module knows, so a hand-built holder with the right shape is
    // still not material. Without this the refusal above could be satisfied by a
    // shape check, and a shape check is what the whole write-only boundary
    // exists instead of.
    const context = buildProvidersTestContext();
    const mimic = {
      reveal: () => "sk-live-mimic",
      toJSON: () => "[redacted]",
      toString: () => "[redacted]",
    };
    const refused = await context.secrets.createCredential({
      name: "MIMIC",
      provider: "openai",
      plaintext: mimic as never,
    });
    expect(refused.ok).toBe(false);
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
