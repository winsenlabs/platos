import { describe, expect, it } from "vitest";

import {
  CATALOGUE_PROVIDER_PREFIX,
  modelLookupKeys,
  PROVIDER_BY_CATALOGUE_PREFIX,
  providerForCatalogueEntry,
  UNKNOWN_PROVIDER,
} from "./model-key.js";

describe("lookup keys", () => {
  it("puts the exact string first and the widest match last", () => {
    expect(modelLookupKeys("openai:gpt-4o")).toEqual(["openai:gpt-4o", "openai/gpt-4o", "gpt-4o"]);
  });

  it("expands a namespaced model down to its last segment, still ordered", () => {
    expect(modelLookupKeys("together:meta-llama/Llama-3.3-70B-Instruct-Turbo")).toEqual([
      "together:meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "together_ai/meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "Llama-3.3-70B-Instruct-Turbo",
    ]);
  });

  it("carries the written-down alias for the model the catalogue renamed", () => {
    expect(modelLookupKeys("together:meta-llama/Llama-3.1-8B-Instruct-Turbo")).toContain(
      "together_ai/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    );
  });

  it("gives a bare embedding model its provider namespace", () => {
    expect(modelLookupKeys("voyage-3-large")).toEqual(["voyage-3-large", "voyage/voyage-3-large"]);
  });

  it("reaches the same namespaced key from the qualified form, by the prefix rule", () => {
    // The bare-name rule and the prefix rule converge here, which is the point:
    // whichever way an operator wrote it, the same card is found.
    expect(modelLookupKeys("voyage:voyage-3-large")).toEqual([
      "voyage:voyage-3-large",
      "voyage/voyage-3-large",
      "voyage-3-large",
    ]);
  });

  it("does not apply the bare-embedding rule to a model of another provider", () => {
    expect(modelLookupKeys("openai:voyage-lookalike")).not.toContain("voyage/voyage-lookalike");
  });

  it("de-duplicates and drops empties", () => {
    const keys = modelLookupKeys("openai:gpt-4o");
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("");
  });

  it("returns nothing for an empty or blank model", () => {
    expect(modelLookupKeys("")).toEqual([]);
    expect(modelLookupKeys("   ")).toEqual([]);
  });

  it("leaves an unmapped provider without a catalogue-prefixed key", () => {
    expect(modelLookupKeys("acme:custom-1")).toEqual(["acme:custom-1", "custom-1"]);
  });
});

describe("the prefix table reads both ways", () => {
  it("inverts without losing a provider", () => {
    for (const [platos, catalogue] of Object.entries(CATALOGUE_PROVIDER_PREFIX)) {
      expect(PROVIDER_BY_CATALOGUE_PREFIX[catalogue]).toBe(platos);
    }
  });
});

describe("naming the provider of a catalogue entry", () => {
  it("prefers what the entry declares, translated back to Platos naming", () => {
    expect(providerForCatalogueEntry("some/model", "together_ai")).toBe("together");
    expect(providerForCatalogueEntry("some/model", "gemini")).toBe("google");
  });

  it("keeps a declared provider the table does not know, rather than discarding it", () => {
    expect(providerForCatalogueEntry("some/model", "brand_new_host")).toBe("brand_new_host");
  });

  it("falls back to the key's own namespace segment", () => {
    expect(providerForCatalogueEntry("vertex_ai/gemini-2.5-pro", null)).toBe("google-vertex");
  });

  it("files an entry with no discoverable provider under a named unknown", () => {
    expect(providerForCatalogueEntry("gpt-4o", null)).toBe(UNKNOWN_PROVIDER);
    expect(providerForCatalogueEntry("gpt-4o", "")).toBe(UNKNOWN_PROVIDER);
  });
});
