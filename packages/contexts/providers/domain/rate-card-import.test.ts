import { describe, expect, it } from "vitest";

import { rateToDecimalString } from "./rate.js";
import {
  capabilitiesFor,
  coerceDate,
  coerceTokenCount,
  overrideForCatalogueKey,
  rateBookFor,
  rateEntryFor,
  RATE_CARD_CATALOGUE_URL,
  verifiedObservedAt,
  verifiedRateFor,
  VERIFIED_RATE_OVERRIDES,
  type RateCardEntry,
} from "./rate-card-import.js";
import { modelLookupKeys } from "./model-key.js";

const FETCHED = new Date("2026-08-01T00:00:00.000Z");

const CATALOGUE_ENTRY: RateCardEntry = {
  input_cost_per_token: 1e-6,
  output_cost_per_token: 6e-6,
  cache_read_input_token_cost: 1e-7,
  cache_creation_input_token_cost: 1.25e-6,
  litellm_provider: "openai",
  mode: "chat",
  supports_vision: true,
  supports_function_calling: true,
};

describe("coercing a count that arrived from parsed JSON", () => {
  it("accepts a safe integer, in either representation", () => {
    expect(coerceTokenCount(128_000)).toBe(128_000);
    expect(coerceTokenCount("128000")).toBe(128_000);
    expect(coerceTokenCount(" 128000 ")).toBe(128_000);
  });

  it("treats anything it cannot read as ABSENT rather than guessing", () => {
    for (const value of [1.5, "1.5", "", "   ", "unlimited", null, undefined, {}, []]) {
      expect(coerceTokenCount(value)).toBeNull();
    }
  });

  it("refuses an integer beyond the safe range instead of rounding it", () => {
    expect(coerceTokenCount(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });
});

describe("coercing a date", () => {
  it("reads an ISO date and rejects nonsense", () => {
    expect(coerceDate("2026-07-31")?.toISOString()).toBe("2026-07-31T00:00:00.000Z");
    expect(coerceDate("not-a-date")).toBeNull();
    expect(coerceDate("")).toBeNull();
    expect(coerceDate(undefined)).toBeNull();
  });

  it("reads a verification date as midnight UTC so it is region-stable", () => {
    expect(verifiedObservedAt("2026-07-31").toISOString()).toBe("2026-07-31T00:00:00.000Z");
  });
});

describe("capabilities", () => {
  it("flattens the flags that are set and drops the ones that are not", () => {
    expect(capabilitiesFor(CATALOGUE_ENTRY)).toEqual(["mode:chat", "function_calling", "vision"]);
  });

  it("emits nothing for an entry that declares nothing", () => {
    expect(capabilitiesFor({})).toEqual([]);
  });

  it("does not treat a falsy-but-present flag as set", () => {
    expect(capabilitiesFor({ supports_vision: false })).toEqual([]);
  });
});

describe("reading one rate", () => {
  it("takes the catalogue's value and records where it came from", () => {
    const entry = rateEntryFor("input", CATALOGUE_ENTRY, FETCHED, null);
    expect(rateToDecimalString(entry.rate)).toBe("0.000001000000");
    expect(entry.source).toBe("LITELLM");
    expect(entry.sourceRef).toBe(RATE_CARD_CATALOGUE_URL);
    expect(entry.observedAt).toBe(FETCHED);
  });

  it("records a rate the catalogue does not publish as UNAVAILABLE, not as zero", () => {
    const entry = rateEntryFor("cacheWrite", { input_cost_per_token: 1e-6 }, FETCHED, null);
    expect(entry.source).toBe("UNAVAILABLE");
    expect(entry.sourceRef).toBeNull();
  });

  it("treats a catalogue value that is not a number as unpublished", () => {
    const entry = rateEntryFor("input", { input_cost_per_token: "1e-6" }, FETCHED, null);
    expect(entry.source).toBe("UNAVAILABLE");
  });

  it("treats a negative catalogue value as unpublished rather than as a credit", () => {
    const entry = rateEntryFor("input", { input_cost_per_token: -1 }, FETCHED, null);
    expect(entry.source).toBe("UNAVAILABLE");
  });
});

describe("a verified correction overrides ONE rate, not the card", () => {
  const override = VERIFIED_RATE_OVERRIDES[0];
  if (override === undefined) throw new Error("the shipped override set must not be empty");

  it("replaces the rates the correction names", () => {
    const book = rateBookFor(CATALOGUE_ENTRY, FETCHED, override);
    expect(book.input.source).toBe("VERIFIED_PROVIDER");
    expect(rateToDecimalString(book.input.rate)).toBe("0.000000200000");
    expect(book.input.sourceRef).toBe(override.source);
    expect(book.input.observedAt.toISOString()).toBe("2026-07-31T00:00:00.000Z");
  });

  it("leaves a rate the correction does not name coming from the catalogue", () => {
    const partial = { ...override, cacheWrite: undefined };
    const book = rateBookFor(CATALOGUE_ENTRY, FETCHED, partial);
    expect(book.cacheWrite.source).toBe("LITELLM");
    expect(rateToDecimalString(book.cacheWrite.rate)).toBe("0.000001250000");
  });

  it("ships its own evidence, so it can be re-checked later", () => {
    for (const entry of VERIFIED_RATE_OVERRIDES) {
      expect(entry.providerQuote).not.toBe("");
      expect(entry.source.startsWith("http")).toBe(true);
      expect(verifiedObservedAt(entry.verifiedOn).toString()).not.toBe("Invalid Date");
    }
  });
});

describe("matching a correction to a catalogue entry", () => {
  it("matches on the provider as well as the name", () => {
    expect(verifiedRateFor(modelLookupKeys("openai:gpt-5.6-luna"), "openai")).not.toBeNull();
    expect(verifiedRateFor(modelLookupKeys("openai:gpt-5.6-luna"), "anthropic")).toBeNull();
  });

  it("does not let a same-named model of another provider inherit the correction", () => {
    expect(verifiedRateFor(modelLookupKeys("together:gpt-5.6-luna"), "together")).toBeNull();
  });

  it("finds it through the catalogue's own prefixed key", () => {
    expect(overrideForCatalogueKey("openai/gpt-5.6-luna", "openai")).not.toBeNull();
  });

  it("finds it from a bare model name qualified by the entry's provider", () => {
    expect(overrideForCatalogueKey("gpt-5.6-luna", "openai")).not.toBeNull();
  });

  it("returns nothing for a blank provider or an uncorrected model", () => {
    expect(verifiedRateFor(["gpt-5.6-luna"], "   ")).toBeNull();
    expect(overrideForCatalogueKey("openai/gpt-4o", "openai")).toBeNull();
  });
});
