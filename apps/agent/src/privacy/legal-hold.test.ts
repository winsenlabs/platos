import { describe, it, expect } from "vitest";
import { parseLegalHoldList, findLegalHold } from "./legal-hold";
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
    expect(findLegalHold(subject(), "a@x.com", ["a@x.com"])).toBe("a@x.com");
  });

  it("matches case-insensitively", () => {
    expect(findLegalHold(subject(), "A@X.com", ["a@x.com"])).toBe("a@x.com");
  });

  it("returns null for a subject nobody registered", () => {
    expect(findLegalHold(subject(), "b@y.com", ["a@x.com"])).toBeNull();
  });

  // The reason this module exists over a plain equality check.
  it("blocks an erasure requested under an alias the hold does not name", () => {
    const s = subject({ legacyUserIds: ["slack:U08JTN5FX39", "a@x.com"] });
    expect(findLegalHold(s, "a@x.com", ["slack:U08JTN5FX39"])).toBe("slack:U08JTN5FX39");
  });

  it("blocks when the hold names the canonical end-user id", () => {
    const s = subject({ platosEndUserIds: ["eu_123"] });
    expect(findLegalHold(s, "a@x.com", ["eu_123"])).toBe("eu_123");
  });

  it("ignores empty aliases so a subject with no history is not held by a blank entry", () => {
    const s = subject({ legacyUserIds: ["", ""] as string[] });
    expect(findLegalHold(s, "a@x.com", ["b@y.com"])).toBeNull();
  });

  it("names which register entry blocked it", () => {
    const s = subject({ legacyUserIds: ["b@y.com"] });
    expect(findLegalHold(s, "a@x.com", ["z@z.com", "b@y.com"])).toBe("b@y.com");
  });
});
