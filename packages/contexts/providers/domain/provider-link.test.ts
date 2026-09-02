import { asIdentifier, type EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { DEFAULT_PROVIDER_CATALOGUE } from "./catalogue.js";
import type { EnvironmentProviderId, ProviderId } from "./identifiers.js";
import { findManifest, readiness, type ProviderManifest } from "./manifest.js";
import {
  enable,
  providerState,
  shouldDiscoverModels,
  usableProviders,
  type ProviderLink,
} from "./provider-link.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function manifestFor(id: string): ProviderManifest {
  const found = findManifest(DEFAULT_PROVIDER_CATALOGUE, id);
  if (found === null) throw new Error(`unreachable: ${id}`);
  return found;
}

function link(overrides: Partial<ProviderLink> = {}): ProviderLink {
  return {
    environmentProviderId: asIdentifier<EnvironmentProviderId>("link-1"),
    environmentId: asIdentifier<EnvironmentId>("env-1"),
    provider: asIdentifier<ProviderId>("openai"),
    enabled: true,
    linkedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function stateFor(
  id: string,
  options: { link: ProviderLink | null; present: Record<string, boolean> },
) {
  const manifest = manifestFor(id);
  return providerState(manifest, options.link, readiness(manifest, options.present), manifest.models);
}

describe("the three facts stay separate", () => {
  it("reports linked, enabled and ready independently", () => {
    const paused = stateFor("openai", {
      link: link({ enabled: false }),
      present: { OPENAI_API_KEY: true },
    });
    expect(paused.linked).toBe(true);
    expect(paused.enabled).toBe(false);
    expect(paused.ready).toBe(true);
  });

  it("reports an adopted provider whose key was never added", () => {
    const unready = stateFor("openai", { link: link(), present: {} });
    expect(unready.linked).toBe(true);
    expect(unready.enabled).toBe(true);
    expect(unready.ready).toBe(false);
  });

  it("reports an unadopted provider whose credential already exists", () => {
    const unlinked = stateFor("openai", { link: null, present: { OPENAI_API_KEY: true } });
    expect(unlinked.linked).toBe(false);
    expect(unlinked.enabled).toBe(false);
    expect(unlinked.ready).toBe(true);
    expect(unlinked.linkedAt).toBeNull();
  });

  it("carries the manifest's own non-secret metadata through untouched", () => {
    const manifest = manifestFor("groq");
    const state = stateFor("groq", { link: link({ provider: asIdentifier<ProviderId>("groq") }), present: {} });
    expect(state.displayName).toBe(manifest.displayName);
    expect(state.probeModel).toBe(manifest.probeModel);
    expect(state.optionalCredentials).toEqual(manifest.optionalCredentials);
  });
});

describe("deciding whether to call the provider for its model list", () => {
  const ready = { OPENAI_API_KEY: true };

  it("calls only when the provider publishes a list and all three facts hold", () => {
    const state = stateFor("openai", { link: link(), present: ready });
    expect(shouldDiscoverModels(manifestFor("openai"), state)).toBe(true);
  });

  it("does not call a paused, unadopted or unready provider", () => {
    expect(
      shouldDiscoverModels(
        manifestFor("openai"),
        stateFor("openai", { link: link({ enabled: false }), present: ready }),
      ),
    ).toBe(false);
    expect(
      shouldDiscoverModels(manifestFor("openai"), stateFor("openai", { link: null, present: ready })),
    ).toBe(false);
    expect(
      shouldDiscoverModels(manifestFor("openai"), stateFor("openai", { link: link(), present: {} })),
    ).toBe(false);
  });

  it("does not call a provider that publishes no list", () => {
    const perplexity = manifestFor("perplexity");
    const state = providerState(
      perplexity,
      link({ provider: asIdentifier<ProviderId>("perplexity") }),
      readiness(perplexity, { PERPLEXITY_API_KEY: true }),
      perplexity.models,
    );
    expect(state.ready).toBe(true);
    expect(shouldDiscoverModels(perplexity, state)).toBe(false);
  });
});

describe("which providers a turn may route to", () => {
  it("keeps only the ones that are linked, enabled and ready", () => {
    const states = [
      stateFor("openai", { link: link(), present: { OPENAI_API_KEY: true } }),
      stateFor("openai", { link: link({ enabled: false }), present: { OPENAI_API_KEY: true } }),
      stateFor("openai", { link: link(), present: {} }),
      stateFor("openai", { link: null, present: { OPENAI_API_KEY: true } }),
    ];
    expect(usableProviders(states)).toHaveLength(1);
  });
});

describe("switching an adoption", () => {
  it("changes only the flag and the timestamp", () => {
    const later = new Date("2026-02-01T00:00:00.000Z");
    const paused = enable(link(), false, later);
    expect(paused.enabled).toBe(false);
    expect(paused.updatedAt).toBe(later);
    expect(paused.linkedAt).toBe(NOW);
  });
});
