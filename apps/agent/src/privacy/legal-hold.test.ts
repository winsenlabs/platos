import { describe, it, expect } from "vitest";
import {
  LEGAL_HOLD_REFERENCE_PREFIX, findLegalHold, legalHoldReference, parseLegalHoldList,
} from "./legal-hold";
import type { SubjectKeys } from "./subject-graph";

const subject = (over: Partial<SubjectKeys> = {}): SubjectKeys => ({
  platosEndUserIds: [],
  legacyUserIds: [],
  scopes: [],
  ...over,
});

describe("parseLegalHoldList", () => {
  it("returns nothing for unset, empty, or whitespace-only registers", () => {
    expect(parseLegalHoldList(undefined)).toEqual([]);
    expect(parseLegalHoldList(null)).toEqual([]);
    expect(parseLegalHoldList("")).toEqual([]);
    expect(parseLegalHoldList("   ")).toEqual([]);
  });

  it("splits and trims", () => {
    expect(parseLegalHoldList("a@x.com, b@y.com ,c@z.com")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });

  it("drops blank entries so a trailing comma cannot match an aliasless subject", () => {
    // The dangerous shape: "" in the list matching "" in a subject's aliases
    // would place every subject on hold, or — with the filters removed on the
    // other side — none of them.
    expect(parseLegalHoldList("a@x.com,,")).toEqual(["a@x.com"]);
  });
});

describe("findLegalHold", () => {
  it("returns null when no register is configured", () => {
    expect(findLegalHold(subject(), "a@x.com", [])).toBeNull();
  });

  it("matches the requested identifier", () => {
    expect(findLegalHold(subject(), "a@x.com", ["a@x.com"])).toEqual({
      value: "a@x.com",
      position: 1,
    });
  });

  it("matches case-insensitively", () => {
    expect(findLegalHold(subject(), "A@X.com", ["a@x.com"])).toMatchObject({ value: "a@x.com" });
  });

  it("returns null for a subject nobody registered", () => {
    expect(findLegalHold(subject(), "b@y.com", ["a@x.com"])).toBeNull();
  });

  // The reason this module exists over a plain equality check.
  it("blocks an erasure requested under an alias the hold does not name", () => {
    const s = subject({ legacyUserIds: ["slack:U08JTN5FX39", "a@x.com"] });
    expect(findLegalHold(s, "a@x.com", ["slack:U08JTN5FX39"])).toMatchObject({
      value: "slack:U08JTN5FX39",
    });
  });

  it("blocks when the hold names the canonical end-user id", () => {
    const s = subject({ platosEndUserIds: ["eu_123"] });
    expect(findLegalHold(s, "a@x.com", ["eu_123"])).toMatchObject({ value: "eu_123" });
  });

  it("ignores empty aliases so a subject with no history is not held by a blank entry", () => {
    const s = subject({ legacyUserIds: ["", ""] as string[] });
    expect(findLegalHold(s, "a@x.com", ["b@y.com"])).toBeNull();
  });

  it("names which register entry blocked it, by position", () => {
    const s = subject({ legacyUserIds: ["b@y.com"] });
    expect(findLegalHold(s, "a@x.com", ["z@z.com", "b@y.com"])).toEqual({
      value: "b@y.com",
      position: 2,
    });
  });
});

describe("legalHoldReference — naming a hold without disclosing it", () => {
  const hash = "9e44968ef6fe1c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70819200";

  it("names the register position and a hash, never the entry", () => {
    // The register is written by a human, so its entries ARE the subject's
    // handles. Writing the matched one into the receipt would persist the
    // subject's Slack id indefinitely, in the record of their erasure.
    const reference = legalHoldReference({ value: "U08JTN5FX39", position: 3 }, hash);

    expect(reference).toBe(`${LEGAL_HOLD_REFERENCE_PREFIX}3:9e44968ef6fe`);
    expect(reference).not.toContain("U08JTN5FX39");
  });

  it("distinguishes two entries that sit in the same position across deployments", () => {
    // Position alone is not identity: a register is an environment variable
    // somebody will reorder. The hash is what makes the reference verifiable.
    const first = legalHoldReference({ value: "a@x.com", position: 1 }, "a".repeat(64));
    const second = legalHoldReference({ value: "b@y.com", position: 1 }, "b".repeat(64));

    expect(first).not.toBe(second);
  });
});
