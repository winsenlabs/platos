import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  asProvidersIdentifier,
  type CredentialName,
  type ProviderId,
  type ProviderKeyId,
} from "../domain/index.js";
import { openModelRoute } from "./open-model-route.js";
import { hasProviderCredential, resolveProviderCredential } from "./resolve-provider-credential.js";
import {
  buildProvidersTestContext,
  otherEnvironment,
  testProviderKey,
  type ProvidersTestContext,
} from "./testing/index.js";

const OPENAI = asProvidersIdentifier<ProviderId>("openai");

function seedKey(context: ProvidersTestContext, overrides: Parameters<typeof testProviderKey>[1] = {}) {
  const credential = context.secrets.seed({
    name: "OPENAI_API_KEY",
    provider: "openai",
    plaintext: "sk-live",
  });
  return context.repository.seedProviderKey(
    testProviderKey(context.scope, { credentialId: credential.id, ...overrides }),
  );
}

describe("selecting which key pays", () => {
  it("uses the environment default when nothing is pinned", async () => {
    const context = buildProvidersTestContext();
    const key = seedKey(context);

    const resolved = await resolveProviderCredential(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      provider: OPENAI,
    });
    if (!resolved.ok) throw new Error(`unreachable: ${resolved.error.code}`);
    expect(resolved.value?.key.providerKeyId).toBe(key.providerKeyId);
    expect(resolved.value?.credential.reveal()).toBe("sk-live");
  });

  it("uses the pinned key, not the default, when one is named", async () => {
    const context = buildProvidersTestContext();
    seedKey(context, { providerKeyId: asProvidersIdentifier<ProviderKeyId>("default-key") });
    const pinnedCredential = context.secrets.seed({
      name: "OPENAI_API_KEY_PINNED",
      provider: "openai",
      plaintext: "sk-pinned",
    });
    context.repository.seedProviderKey(
      testProviderKey(context.scope, {
        providerKeyId: asProvidersIdentifier<ProviderKeyId>("pinned"),
        label: "pinned",
        isDefault: false,
        credentialId: pinnedCredential.id,
      }),
    );

    const resolved = await resolveProviderCredential(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      provider: OPENAI,
      providerKeyId: asProvidersIdentifier<ProviderKeyId>("pinned"),
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value?.credential.reveal()).toBe("sk-pinned");
  });

  it("FAILS CLOSED on a pin that does not resolve — it never falls back", async () => {
    const context = buildProvidersTestContext();
    seedKey(context, { providerKeyId: asProvidersIdentifier<ProviderKeyId>("default-key") });

    const denied = await resolveProviderCredential(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      provider: OPENAI,
      providerKeyId: asProvidersIdentifier<ProviderKeyId>("does-not-exist"),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_CONFIGURATION_UNAVAILABLE");
  });

  it("fails closed on a pin that names another provider's key", async () => {
    const context = buildProvidersTestContext();
    const anthropic = context.secrets.seed({
      name: "ANTHROPIC_API_KEY",
      provider: "anthropic",
      plaintext: "sk-ant",
    });
    context.repository.seedProviderKey(
      testProviderKey(context.scope, {
        providerKeyId: asProvidersIdentifier<ProviderKeyId>("anthropic-key"),
        provider: asProvidersIdentifier<ProviderId>("anthropic"),
        credentialId: anthropic.id,
      }),
    );

    const denied = await resolveProviderCredential(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      provider: OPENAI,
      providerKeyId: asProvidersIdentifier<ProviderKeyId>("anthropic-key"),
    });
    expect(denied.ok).toBe(false);
  });

  it("fails closed on a pin that names another environment's key", async () => {
    const context = buildProvidersTestContext();
    context.repository.seedProviderKey(
      testProviderKey(otherEnvironment(), {
        providerKeyId: asProvidersIdentifier<ProviderKeyId>("theirs"),
      }),
    );
    const denied = await resolveProviderCredential(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      provider: OPENAI,
      providerKeyId: asProvidersIdentifier<ProviderKeyId>("theirs"),
    });
    expect(denied.ok).toBe(false);
  });

  it("reports NO key as an absence rather than as a failure", async () => {
    const context = buildProvidersTestContext();
    const resolved = await resolveProviderCredential(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      provider: OPENAI,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value).toBeNull();
  });

  it("does not widen to a key registered for a DIFFERENT provider", async () => {
    const context = buildProvidersTestContext();
    const anthropic = context.secrets.seed({
      name: "ANTHROPIC_API_KEY",
      provider: "anthropic",
      plaintext: "sk-ant",
    });
    context.repository.seedProviderKey(
      testProviderKey(context.scope, {
        provider: asProvidersIdentifier<ProviderId>("anthropic"),
        credentialId: anthropic.id,
      }),
    );
    const resolved = await resolveProviderCredential(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      provider: OPENAI,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value).toBeNull();
  });
});

describe("the grant is checked against the scope it is used for", () => {
  it("refuses a grant minted for a different environment", async () => {
    const context = buildProvidersTestContext();
    seedKey(context);
    const denied = await resolveProviderCredential(context.dependencies, {
      authorization: context.secrets.runtimeGrant(otherEnvironment()),
      scope: context.scope,
      provider: OPENAI,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_SCOPE_MISMATCH");
  });
});

describe("bookkeeping", () => {
  it("stamps lastUsedAt without letting that write decide the outcome", async () => {
    const context = buildProvidersTestContext();
    const key = seedKey(context);
    context.clock.advanceSeconds(60);

    const resolved = await resolveProviderCredential(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      provider: OPENAI,
    });
    if (!resolved.ok) throw new Error("unreachable");
    const stored = context.repository.allProviderKeys().find((row) => row.providerKeyId === key.providerKeyId);
    expect(stored?.lastUsedAt?.toISOString()).toBe("2026-01-01T00:01:00.000Z");
  });

  it("answers whether a provider has any key at all, without reading one", async () => {
    const context = buildProvidersTestContext();
    const before = await hasProviderCredential(context.dependencies, context.scope, OPENAI);
    if (!before.ok) throw new Error("unreachable");
    expect(before.value).toBe(false);

    seedKey(context);
    const after = await hasProviderCredential(context.dependencies, context.scope, OPENAI);
    if (!after.ok) throw new Error("unreachable");
    expect(after.value).toBe(true);
  });
});

describe("opening a route for a turn", () => {
  it("hands the router a finished plan and the real material", async () => {
    const context = buildProvidersTestContext();
    seedKey(context);

    const opened = await openModelRoute(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      model: "openai:gpt-4o",
    });
    if (!opened.ok) throw new Error(`unreachable: ${opened.error.code}`);
    expect(context.modelRouter.opens).toEqual([
      {
        provider: "openai",
        model: "gpt-4o",
        baseUrl: null,
        chatCompletionsOnly: false,
        revealed: "sk-live",
      },
    ]);
    expect(opened.value.providerKey.providerKeyId).toBe("key-1");
  });

  it("applies the environment's configured root and pins the older surface", async () => {
    const context = buildProvidersTestContext();
    seedKey(context);
    context.secrets.seed({
      name: "OPENAI_BASE_URL",
      provider: "openai",
      plaintext: "https://gw.example.invalid/",
    });

    const opened = await openModelRoute(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      model: "openai:gpt-4o",
    });
    if (!opened.ok) throw new Error(`unreachable: ${opened.error.code}`);
    expect(opened.value.session.plan.baseUrl).toBe("https://gw.example.invalid/v1");
    expect(opened.value.session.plan.chatCompletionsOnly).toBe(true);
  });

  it("REFUSES rather than routing a turn when no key is registered", async () => {
    const context = buildProvidersTestContext();
    const denied = await openModelRoute(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      model: "openai:gpt-4o",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_CONFIGURATION_UNAVAILABLE");
    expect(context.modelRouter.opens).toEqual([]);
  });

  it("refuses an azure route with no per-resource root configured", async () => {
    const context = buildProvidersTestContext();
    const credential = context.secrets.seed({
      name: "AZURE_OPENAI_API_KEY",
      provider: "azure",
      plaintext: "sk-azure",
    });
    context.repository.seedProviderKey(
      testProviderKey(context.scope, {
        provider: asProvidersIdentifier<ProviderId>("azure"),
        credentialName: asIdentifier<CredentialName>("AZURE_OPENAI_API_KEY"),
        credentialId: credential.id,
      }),
    );

    const denied = await openModelRoute(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      model: "azure:gpt-4o",
    });
    expect(denied.ok).toBe(false);
    expect(context.modelRouter.opens).toEqual([]);
  });

  it("refuses a provider the catalogue does not know", async () => {
    const context = buildProvidersTestContext();
    const denied = await openModelRoute(context.dependencies, {
      authorization: context.secrets.runtimeGrant(),
      scope: context.scope,
      model: "not-a-provider:some-model",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_CONFIGURATION_UNAVAILABLE");
  });
});
