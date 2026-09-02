import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { ModelId, ModelKey, ProviderId } from "./identifiers.js";
import {
  admitModelKey,
  isSelectable,
  MAX_MODEL_KEY_LENGTH,
  sameModelFacts,
  type Model,
  type ModelFacts,
} from "./model.js";

const SOURCE_READ_AT = new Date("2026-08-01T00:00:00.000Z");

function facts(overrides: Partial<ModelFacts> = {}): ModelFacts {
  return {
    provider: asIdentifier<ProviderId>("openai"),
    name: "gpt-4o",
    displayName: "GPT-4o",
    description: null,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    capabilities: ["mode:chat", "vision"],
    releaseDate: new Date("2026-01-01T00:00:00.000Z"),
    deprecationDate: null,
    baseModelName: null,
    sourceUpdatedAt: SOURCE_READ_AT,
    ...overrides,
  };
}

function model(overrides: Partial<Model> = {}): Model {
  return {
    modelId: asIdentifier<ModelId>("model-1"),
    key: asIdentifier<ModelKey>("openai/gpt-4o"),
    isHidden: false,
    ...facts(),
    ...overrides,
  };
}

describe("admitting a model key", () => {
  it("accepts an ordinary key", () => {
    const admitted = admitModelKey("openai/gpt-4o");
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toBe("openai/gpt-4o");
  });

  it("refuses an empty key and one that is only whitespace", () => {
    expect(admitModelKey("").ok).toBe(false);
    expect(admitModelKey("   ").ok).toBe(false);
  });

  it("refuses a key with surrounding whitespace rather than silently trimming it", () => {
    // Trimming would make two distinct catalogue entries collide on one row.
    const denied = admitModelKey(" openai/gpt-4o");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_MODEL_KEY_INVALID");
  });

  it("caps the length", () => {
    expect(admitModelKey("x".repeat(MAX_MODEL_KEY_LENGTH)).ok).toBe(true);
    expect(admitModelKey("x".repeat(MAX_MODEL_KEY_LENGTH + 1)).ok).toBe(false);
  });
});

describe("selectability", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");

  it("offers a live, visible model", () => {
    expect(isSelectable(model(), now)).toBe(true);
  });

  it("withholds a hidden model even when it is live", () => {
    expect(isSelectable(model({ isHidden: true }), now)).toBe(false);
  });

  it("withholds a model whose end date has passed, and offers one whose has not", () => {
    expect(isSelectable(model({ deprecationDate: new Date("2026-05-01T00:00:00.000Z") }), now)).toBe(
      false,
    );
    expect(isSelectable(model({ deprecationDate: new Date("2026-07-01T00:00:00.000Z") }), now)).toBe(
      true,
    );
  });

  it("withholds a model at exactly its end instant", () => {
    expect(isSelectable(model({ deprecationDate: now }), now)).toBe(false);
  });
});

describe("has anything about this model changed?", () => {
  it("ignores sourceUpdatedAt, which moves on every catalogue pass", () => {
    expect(
      sameModelFacts(facts(), facts({ sourceUpdatedAt: new Date("2026-09-01T00:00:00.000Z") })),
    ).toBe(true);
  });

  it("notices every fact that is actually a fact", () => {
    expect(sameModelFacts(facts(), facts({ displayName: "GPT-4 Omni" }))).toBe(false);
    expect(sameModelFacts(facts(), facts({ contextWindow: 200_000 }))).toBe(false);
    expect(sameModelFacts(facts(), facts({ provider: asIdentifier<ProviderId>("azure") }))).toBe(false);
    expect(sameModelFacts(facts(), facts({ maxOutputTokens: null }))).toBe(false);
    expect(sameModelFacts(facts(), facts({ baseModelName: "gpt-4" }))).toBe(false);
  });

  it("compares dates by instant, and distinguishes absent from present", () => {
    expect(
      sameModelFacts(facts(), facts({ releaseDate: new Date("2026-01-01T00:00:00.000Z") })),
    ).toBe(true);
    expect(sameModelFacts(facts(), facts({ releaseDate: null }))).toBe(false);
    expect(sameModelFacts(facts({ releaseDate: null }), facts({ releaseDate: null }))).toBe(true);
  });

  it("compares capabilities set-wise, because their order carries no meaning", () => {
    expect(sameModelFacts(facts(), facts({ capabilities: ["vision", "mode:chat"] }))).toBe(true);
    expect(sameModelFacts(facts(), facts({ capabilities: ["vision"] }))).toBe(false);
    expect(sameModelFacts(facts(), facts({ capabilities: ["vision", "reasoning"] }))).toBe(false);
  });
});
