import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  distinctRequiredKeys,
  environmentReadiness,
  isEnvironmentReady,
  isKeySet,
  missingKeys,
} from "./environment-readiness.js";
import type { EnvironmentKey } from "./identifiers.js";

const key = (value: string): EnvironmentKey => asIdentifier<EnvironmentKey>(value);

describe("isKeySet", () => {
  it("is true only for an explicit true", () => {
    expect(isKeySet({ A: true }, key("A"))).toBe(true);
    expect(isKeySet({ A: false }, key("A"))).toBe(false);
  });

  it("treats a key the map does not mention as NOT set", () => {
    expect(isKeySet({}, key("A"))).toBe(false);
  });
});

describe("missingKeys", () => {
  it("returns only the unset keys, in declaration order", () => {
    expect(missingKeys([key("A"), key("B"), key("C")], { A: true, B: false, C: false })).toEqual(["B", "C"]);
  });

  it("returns nothing when everything is set", () => {
    expect(missingKeys([key("A")], { A: true })).toEqual([]);
  });

  it("returns nothing when nothing is required", () => {
    expect(missingKeys([], {})).toEqual([]);
  });
});

describe("isEnvironmentReady", () => {
  it("is true when every required key is set", () => {
    expect(isEnvironmentReady([key("A"), key("B")], { A: true, B: true })).toBe(true);
  });

  it("is FALSE when even one is unset", () => {
    expect(isEnvironmentReady([key("A"), key("B")], { A: true, B: false })).toBe(false);
  });

  it("is true when a skill requires nothing — the common case", () => {
    expect(isEnvironmentReady([], {})).toBe(true);
  });
});

describe("environmentReadiness", () => {
  it("reports NULL when readiness was not evaluated at all", () => {
    // Not false. A row read outside any environment was not checked, and saying
    // so is different from saying it failed.
    expect(environmentReadiness([key("A")], null)).toBeNull();
  });

  it("reports null for a requirement-free skill too, when unevaluated", () => {
    expect(environmentReadiness([], null)).toBeNull();
  });

  it("reports true and false once it HAS been evaluated", () => {
    expect(environmentReadiness([key("A")], { A: true })).toBe(true);
    expect(environmentReadiness([key("A")], { A: false })).toBe(false);
    expect(environmentReadiness([], {})).toBe(true);
  });
});

describe("distinctRequiredKeys", () => {
  it("collapses keys shared across skills into one lookup", () => {
    expect(distinctRequiredKeys([[key("A"), key("B")], [key("B"), key("C")]])).toEqual(["A", "B", "C"]);
  });

  it("is empty when no skill requires anything", () => {
    expect(distinctRequiredKeys([[], []])).toEqual([]);
  });
});
