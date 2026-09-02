import { describe, expect, it } from "vitest";

import { DEFAULT_PROVIDER_CATALOGUE } from "./catalogue.js";
import {
  apiKeyCredentialName,
  findManifest,
  mergeModelLists,
  MODEL_LIST_AUTH,
  MODEL_LIST_SHAPES,
  PROVIDER_DIALECTS,
  qualifyModel,
  readiness,
  requireManifest,
  type ProviderManifest,
} from "./manifest.js";
import { asProvidersIdentifier, type ProviderId } from "./identifiers.js";

function manifestFor(id: string): ProviderManifest {
  const found = findManifest(DEFAULT_PROVIDER_CATALOGUE, id);
  if (found === null) throw new Error(`unreachable: ${id}`);
  return found;
}

describe("the shipped catalogue is well formed", () => {
  it("names every provider exactly once", () => {
    const ids = DEFAULT_PROVIDER_CATALOGUE.map((manifest) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares only known dialects, shapes and auth styles", () => {
    for (const manifest of DEFAULT_PROVIDER_CATALOGUE) {
      expect(PROVIDER_DIALECTS).toContain(manifest.dialect);
      if (manifest.modelList !== null) {
        expect(MODEL_LIST_SHAPES).toContain(manifest.modelList.shape);
        expect(MODEL_LIST_AUTH).toContain(manifest.modelList.auth);
      }
    }
  });

  it("gives every provider at least one required credential and one curated model", () => {
    for (const manifest of DEFAULT_PROVIDER_CATALOGUE) {
      expect(manifest.requiredCredentials.length).toBeGreaterThan(0);
      expect(manifest.models.length).toBeGreaterThan(0);
      expect(manifest.probeModel).not.toBe("");
    }
  });

  it("qualifies every curated model with its own provider", () => {
    for (const manifest of DEFAULT_PROVIDER_CATALOGUE) {
      for (const model of manifest.models) {
        expect(model.startsWith(`${manifest.id}:`)).toBe(true);
      }
    }
  });

  it("gives every OpenAI-compatible provider a base url and no other dialect one", () => {
    for (const manifest of DEFAULT_PROVIDER_CATALOGUE) {
      if (manifest.dialect === "openai-compatible") {
        expect(manifest.baseUrl).not.toBeNull();
      } else {
        expect(manifest.baseUrl).toBeNull();
      }
    }
  });

  it("carries no credential material anywhere in it", () => {
    const rendered = JSON.stringify(DEFAULT_PROVIDER_CATALOGUE);
    for (const marker of ["sk-", "Bearer ", "PRIVATE KEY", "password"]) {
      expect(rendered).not.toContain(marker);
    }
  });
});

describe("finding a manifest", () => {
  it("returns null rather than throwing for an unknown provider", () => {
    expect(findManifest(DEFAULT_PROVIDER_CATALOGUE, "nope")).toBeNull();
  });

  it("refuses an unknown provider with a stable code when one is required", () => {
    const denied = requireManifest(DEFAULT_PROVIDER_CATALOGUE, "nope");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_UNKNOWN_PROVIDER");
  });
});

describe("the API-key slot is the first required credential", () => {
  it("reads it from manifest order", () => {
    expect(apiKeyCredentialName(manifestFor("anthropic"))).toBe("ANTHROPIC_API_KEY");
    // Azure declares its per-resource root as a second REQUIRED credential, so
    // this is the case where order actually decides which one is the key.
    expect(apiKeyCredentialName(manifestFor("azure"))).toBe("AZURE_OPENAI_API_KEY");
  });
});

describe("readiness", () => {
  const azure = manifestFor("azure");

  it("is ready only when every required credential is present", () => {
    expect(readiness(azure, { AZURE_OPENAI_API_KEY: true }).ready).toBe(false);
    expect(
      readiness(azure, { AZURE_OPENAI_API_KEY: true, AZURE_OPENAI_BASE_URL: true }).ready,
    ).toBe(true);
  });

  it("reports per-name presence in manifest order", () => {
    const report = readiness(azure, { AZURE_OPENAI_BASE_URL: true });
    expect(report.required.map((entry) => entry.name)).toEqual([
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_BASE_URL",
    ]);
    expect(report.required.map((entry) => entry.present)).toEqual([false, true]);
  });

  it("lets a linked provider credential satisfy the API-key slot ALONE", () => {
    const report = readiness(azure, {}, true);
    expect(report.required[0]?.present).toBe(true);
    expect(report.required[1]?.present).toBe(false);
    expect(report.ready).toBe(false);
  });

  it("treats an absent name as absent, never as present", () => {
    expect(readiness(manifestFor("anthropic"), {}).ready).toBe(false);
  });
});

describe("merging model lists", () => {
  it("keeps the curated list first and appends only what is new", () => {
    expect(mergeModelLists(["a:1", "a:2"], ["a:2", "a:3"])).toEqual(["a:1", "a:2", "a:3"]);
  });

  it("does not reorder a curated entry the live list repeats", () => {
    expect(mergeModelLists(["a:1", "a:2"], ["a:2"])).toEqual(["a:1", "a:2"]);
  });

  it("de-duplicates within the live list too", () => {
    expect(mergeModelLists([], ["a:1", "a:1"])).toEqual(["a:1"]);
  });

  it("keeps the curated list when the live one is empty", () => {
    expect(mergeModelLists(["a:1"], [])).toEqual(["a:1"]);
  });
});

describe("qualifying a model", () => {
  it("joins provider and model with a colon", () => {
    expect(qualifyModel(asProvidersIdentifier<ProviderId>("groq"), "llama-3.1-8b-instant")).toBe(
      "groq:llama-3.1-8b-instant",
    );
  });
});
