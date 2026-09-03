import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { ModelId, ModelKey, ModelPriceId, ProviderId } from "./identifiers.js";
import {
  byEffectiveFromDescending,
  cardInForceAt,
  chargeableRate,
  isRateKnown,
  isRateSource,
  sameCard,
  sameRateEntry,
  selectByKeyPrecedence,
  unavailableRate,
  type ModelPriceSnapshot,
  type RateBook,
  type RateEntry,
} from "./price-card.js";
import { rateFromNumber } from "./rate.js";

const OBSERVED = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-02-01T00:00:00.000Z");

function entry(usdPerToken: number, overrides: Partial<RateEntry> = {}): RateEntry {
  const rate = rateFromNumber(usdPerToken);
  if (!rate.ok) throw new Error("unreachable");
  return {
    rate: rate.value,
    source: "LITELLM",
    observedAt: OBSERVED,
    sourceRef: "catalogue",
    ...overrides,
  };
}

function book(overrides: Partial<RateBook> = {}): RateBook {
  return {
    input: entry(1e-6),
    output: entry(2e-6),
    cacheRead: entry(1e-7),
    cacheWrite: entry(1.25e-6),
    ...overrides,
  };
}

function snapshot(
  key: string,
  effectiveFrom: Date,
  overrides: Partial<ModelPriceSnapshot> = {},
): ModelPriceSnapshot {
  return {
    modelPriceId: asIdentifier<ModelPriceId>(`price-${key}-${effectiveFrom.toISOString()}`),
    modelId: asIdentifier<ModelId>(`model-${key}`),
    modelKey: asIdentifier<ModelKey>(key),
    provider: asIdentifier<ProviderId>("openai"),
    modelName: key,
    effectiveFrom,
    rates: book(),
    ...overrides,
  };
}

describe("the stored rate source enum", () => {
  it("admits exactly the three the canonical store declares", () => {
    for (const value of ["LITELLM", "VERIFIED_PROVIDER", "UNAVAILABLE"]) {
      expect(isRateSource(value)).toBe(true);
    }
    expect(isRateSource("OPERATOR")).toBe(false);
    expect(isRateSource("litellm")).toBe(false);
  });

  it("distinguishes an unknown rate from a zero one", () => {
    expect(isRateKnown(unavailableRate(OBSERVED))).toBe(false);
    expect(isRateKnown(entry(0))).toBe(true);
  });
});

describe("is this the same price fact?", () => {
  it("compares the rate, the source and the reference", () => {
    expect(sameRateEntry(entry(1e-6), entry(1e-6))).toBe(true);
    expect(sameRateEntry(entry(1e-6), entry(2e-6))).toBe(false);
    expect(sameRateEntry(entry(1e-6), entry(1e-6, { sourceRef: "elsewhere" }))).toBe(false);
    expect(sameRateEntry(entry(1e-6), entry(1e-6, { source: "VERIFIED_PROVIDER" }))).toBe(false);
  });

  it("IGNORES observedAt for a catalogue rate — the catalogue is re-read on a schedule", () => {
    const stored = entry(1e-6);
    const reread = entry(1e-6, { observedAt: LATER });
    expect(sameRateEntry(stored, reread)).toBe(true);
  });

  it("HONOURS observedAt for a verified rate — a re-check is a new fact", () => {
    const verified = { source: "VERIFIED_PROVIDER" as const, sourceRef: "https://example.invalid" };
    const stored = entry(1e-6, verified);
    const rechecked = entry(1e-6, { ...verified, observedAt: LATER });
    expect(sameRateEntry(stored, rechecked)).toBe(false);
  });

  it("compares all four rates of a card", () => {
    expect(sameCard(book(), book())).toBe(true);
    expect(sameCard(book(), book({ cacheWrite: entry(9e-6) }))).toBe(false);
  });
});

describe("charging against a rate", () => {
  it("refuses a non-zero count against an unknown rate", () => {
    const denied = chargeableRate("m", "output", 1, unavailableRate(OBSERVED));
    expect(denied.ok).toBe(false);
  });

  it("permits a zero count against an unknown rate", () => {
    const allowed = chargeableRate("m", "output", 0, unavailableRate(OBSERVED));
    expect(allowed.ok).toBe(true);
  });
});

describe("effective dating", () => {
  const history = [
    { effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), rates: book() },
    { effectiveFrom: new Date("2026-03-01T00:00:00.000Z"), rates: book() },
    { effectiveFrom: new Date("2026-02-01T00:00:00.000Z"), rates: book() },
  ];

  it("returns the latest card at or before the instant", () => {
    const found = cardInForceAt(history, new Date("2026-02-15T00:00:00.000Z"));
    expect(found?.effectiveFrom.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("includes a card that becomes effective at exactly this instant", () => {
    const found = cardInForceAt(history, new Date("2026-02-01T00:00:00.000Z"));
    expect(found?.effectiveFrom.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("hides a card dated in the future", () => {
    const found = cardInForceAt(history, new Date("2025-12-31T23:59:59.999Z"));
    expect(found).toBeNull();
  });

  it("orders newest first", () => {
    const sorted = [...history].sort(byEffectiveFromDescending);
    expect(sorted.map((card) => card.effectiveFrom.toISOString())).toEqual([
      "2026-03-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });
});

describe("key precedence", () => {
  const at = new Date("2026-06-01T00:00:00.000Z");

  it("prefers the earlier key even when a later key has a fresher card", () => {
    const chosen = selectByKeyPrecedence(
      ["openai:gpt-4o", "gpt-4o"],
      [
        snapshot("gpt-4o", new Date("2026-05-01T00:00:00.000Z")),
        snapshot("openai:gpt-4o", new Date("2026-01-01T00:00:00.000Z")),
      ],
      at,
    );
    expect(chosen?.modelKey).toBe("openai:gpt-4o");
  });

  it("takes the newest card within one key", () => {
    const chosen = selectByKeyPrecedence(
      ["openai:gpt-4o"],
      [
        snapshot("openai:gpt-4o", new Date("2026-01-01T00:00:00.000Z")),
        snapshot("openai:gpt-4o", new Date("2026-05-01T00:00:00.000Z")),
      ],
      at,
    );
    expect(chosen?.effectiveFrom.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("ignores a card that is not yet in force and falls through to the next key", () => {
    const chosen = selectByKeyPrecedence(
      ["openai:gpt-4o", "gpt-4o"],
      [
        snapshot("openai:gpt-4o", new Date("2027-01-01T00:00:00.000Z")),
        snapshot("gpt-4o", new Date("2026-01-01T00:00:00.000Z")),
      ],
      at,
    );
    expect(chosen?.modelKey).toBe("gpt-4o");
  });

  it("returns nothing when no key resolves", () => {
    expect(selectByKeyPrecedence(["nope"], [snapshot("gpt-4o", at)], at)).toBeNull();
  });
});
