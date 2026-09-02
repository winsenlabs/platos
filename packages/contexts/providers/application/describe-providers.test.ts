import { describe, expect, it } from "vitest";

import { asProvidersIdentifier, type ProviderId } from "../domain/index.js";
import {
  describeProvider,
  describeProviders,
  listUsableProviders,
  setProviderAdoption,
  unlinkProvider,
} from "./describe-providers.js";
import {
  buildProvidersTestContext,
  testProviderKey,
  type ProvidersTestContext,
} from "./testing/index.js";

const OPENAI = asProvidersIdentifier<ProviderId>("openai");

function configureOpenAi(context: ProvidersTestContext): void {
  const credential = context.secrets.seed({
    name: "OPENAI_API_KEY",
    provider: "openai",
    plaintext: "sk-live",
  });
  context.repository.seedProviderKey(
    testProviderKey(context.scope, { credentialId: credential.id }),
  );
}

async function adopt(context: ProvidersTestContext, enabled = true) {
  return setProviderAdoption(context.dependencies, {
    authorization: context.tenancy.grant(),
    provider: "openai",
    enabled,
  });
}

describe("the registry", () => {
  it("returns one state per catalogue entry, in catalogue order", async () => {
    const context = buildProvidersTestContext();
    const states = await describeProviders(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
    });
    if (!states.ok) throw new Error(`unreachable: ${states.error.code}`);
    expect(states.value.map((state) => state.provider)).toEqual(
      context.dependencies.catalogue.map((manifest) => manifest.id),
    );
  });

  it("reports a provider nobody has adopted as unlinked and disabled", async () => {
    const context = buildProvidersTestContext();
    const state = await describeProvider(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      provider: "openai",
    });
    if (!state.ok) throw new Error("unreachable");
    expect(state.value.linked).toBe(false);
    expect(state.value.enabled).toBe(false);
    expect(state.value.ready).toBe(false);
    expect(state.value.models).toEqual(
      context.dependencies.catalogue.find((manifest) => manifest.id === OPENAI)?.models,
    );
  });

  it("counts a linked ProviderKey as satisfying the API-key slot", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    const state = await describeProvider(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      provider: "openai",
    });
    if (!state.ok) throw new Error("unreachable");
    expect(state.value.ready).toBe(true);
  });

  it("asks the vault for this environment's credentials ONCE for the whole page", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);

    const states = await describeProviders(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
    });
    if (!states.ok) throw new Error("unreachable");
    // Fourteen providers, one read. Reading per provider is the same answer at
    // fourteen times the cost, and it is what this loop looked like before.
    expect(states.value.length).toBeGreaterThan(1);
    expect(context.secrets.listCalls).toBe(1);
  });

  it("refuses a provider the catalogue does not know", async () => {
    const context = buildProvidersTestContext();
    const denied = await describeProvider(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      provider: "not-a-provider",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_UNKNOWN_PROVIDER");
  });
});

describe("adopting and pausing", () => {
  it("adopts a provider that has no row, then switches it off in place", async () => {
    const context = buildProvidersTestContext();
    const adopted = await adopt(context);
    if (!adopted.ok) throw new Error(`unreachable: ${adopted.error.code}`);
    expect(adopted.value.linked).toBe(true);
    expect(adopted.value.enabled).toBe(true);

    const paused = await adopt(context, false);
    if (!paused.ok) throw new Error("unreachable");
    expect(paused.value.linked).toBe(true);
    expect(paused.value.enabled).toBe(false);
    // Still one adoption, not two.
    const links = await context.repository.listProviderLinks(context.scope);
    if (!links.ok) throw new Error("unreachable");
    expect(links.value).toHaveLength(1);
  });

  it("keeps the original adoption instant when it is switched off", async () => {
    const context = buildProvidersTestContext();
    const adopted = await adopt(context);
    if (!adopted.ok) throw new Error("unreachable");
    context.clock.advanceSeconds(3_600);
    const paused = await adopt(context, false);
    if (!paused.ok) throw new Error("unreachable");
    expect(paused.value.linkedAt?.toISOString()).toBe(adopted.value.linkedAt?.toISOString());
  });

  it("requires secret:mutate to adopt or release, and metadata to read", async () => {
    const context = buildProvidersTestContext();
    const denied = await setProviderAdoption(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      provider: "openai",
      enabled: true,
    });
    expect(denied.ok).toBe(false);

    const readable = await describeProviders(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
    });
    expect(readable.ok).toBe(true);
  });

  it("forgets the cached answers when a provider is released", async () => {
    const context = buildProvidersTestContext();
    await adopt(context);
    const released = await unlinkProvider(context.dependencies, {
      authorization: context.tenancy.grant(),
      provider: "openai",
    });
    if (!released.ok) throw new Error("unreachable");
    expect(released.value).toBe(true);
    expect(context.probeCache.forgotten).toEqual([OPENAI]);
  });
});

describe("the live model list", () => {
  it("is NOT fetched without a runtime grant, and the curated list stands", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    await adopt(context);
    context.modelRouter.publishModels("openai", ["gpt-5-preview"]);

    const state = await describeProvider(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      provider: "openai",
    });
    if (!state.ok) throw new Error("unreachable");
    expect(context.modelRouter.listCalls).toEqual([]);
    expect(state.value.models).not.toContain("openai:gpt-5-preview");
  });

  it("is fetched with a runtime grant, and unions under the curated list", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    await adopt(context);
    context.modelRouter.publishModels("openai", ["gpt-5-preview", "gpt-4o"]);

    const state = await describeProvider(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      runtimeAuthorization: context.secrets.runtimeGrant(),
      provider: "openai",
    });
    if (!state.ok) throw new Error("unreachable");
    expect(state.value.models[0]).toBe("openai:gpt-4.1");
    expect(state.value.models).toContain("openai:gpt-5-preview");
    // The curated `openai:gpt-4o` is not repeated by the live one.
    expect(state.value.models.filter((model) => model === "openai:gpt-4o")).toHaveLength(1);
  });

  it("is not fetched for a provider that is paused or unready", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    await adopt(context, false);

    await describeProvider(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      runtimeAuthorization: context.secrets.runtimeGrant(),
      provider: "openai",
    });
    expect(context.modelRouter.listCalls).toEqual([]);
  });

  it("narrows the picker rather than failing the page when the upstream is down", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    await adopt(context);
    context.modelRouter.breakProvider("openai");

    const state = await describeProvider(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      runtimeAuthorization: context.secrets.runtimeGrant(),
      provider: "openai",
    });
    if (!state.ok) throw new Error("unreachable");
    expect(state.value.models).toEqual(
      context.dependencies.catalogue.find((manifest) => manifest.id === OPENAI)?.models,
    );
  });

  it("caches the empty answer briefly so a broken upstream is not called per page", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    await adopt(context);
    context.modelRouter.breakProvider("openai");

    const query = {
      authorization: context.tenancy.grant("metadata"),
      runtimeAuthorization: context.secrets.runtimeGrant(),
      provider: "openai",
    };
    await describeProvider(context.dependencies, query);
    await describeProvider(context.dependencies, query);
    expect(context.modelRouter.listCalls).toHaveLength(1);

    context.clock.advanceSeconds(30);
    await describeProvider(context.dependencies, query);
    expect(context.modelRouter.listCalls).toHaveLength(2);
  });

  it("is never fetched for a provider that publishes no list", async () => {
    const context = buildProvidersTestContext();
    const credential = context.secrets.seed({
      name: "PERPLEXITY_API_KEY",
      provider: "perplexity",
      plaintext: "sk-pplx",
    });
    context.repository.seedProviderKey(
      testProviderKey(context.scope, {
        provider: asProvidersIdentifier<ProviderId>("perplexity"),
        credentialId: credential.id,
      }),
    );
    await setProviderAdoption(context.dependencies, {
      authorization: context.tenancy.grant(),
      provider: "perplexity",
      enabled: true,
    });

    await describeProvider(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      runtimeAuthorization: context.secrets.runtimeGrant(),
      provider: "perplexity",
    });
    expect(context.modelRouter.listCalls).toEqual([]);
  });
});

describe("which providers a turn may route to", () => {
  it("keeps only the ones that are linked, enabled and ready", async () => {
    const context = buildProvidersTestContext();
    configureOpenAi(context);
    await adopt(context);
    // Adopted but with no credential at all.
    await setProviderAdoption(context.dependencies, {
      authorization: context.tenancy.grant(),
      provider: "groq",
      enabled: true,
    });

    const usable = await listUsableProviders(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
    });
    if (!usable.ok) throw new Error("unreachable");
    expect(usable.value.map((state) => state.provider)).toEqual([OPENAI]);
  });
});
