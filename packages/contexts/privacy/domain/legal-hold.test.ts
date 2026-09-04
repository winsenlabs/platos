import { describe, expect, it } from "vitest";

import {
  LEGAL_HOLD_REFERENCE_DIGEST_LENGTH,
  LEGAL_HOLD_REFERENCE_PREFIX,
  findLegalHold,
  isLegalHoldReference,
  legalHoldReference,
  parseLegalHoldList,
} from "./legal-hold.js";

describe("parseLegalHoldList", () => {
  it("splits, trims and drops blanks so a trailing comma cannot mint an empty entry", () => {
    expect(parseLegalHoldList(" a@b.c , U08JTN5FX39 ,, ")).toEqual(["a@b.c", "U08JTN5FX39"]);
  });

  it("treats an absent register as no holds rather than as one blank hold", () => {
    expect(parseLegalHoldList(null)).toEqual([]);
    expect(parseLegalHoldList(undefined)).toEqual([]);
    expect(parseLegalHoldList("")).toEqual([]);
  });
});

describe("findLegalHold", () => {
  const register = ["ops@example.com", "U08JTN5FX39"];

  it("matches an alias the request did not name — the whole point of the alias set", () => {
    const match = findLegalHold(["walle-1", "u08jtn5fx39"], register);
    expect(match).toEqual({ value: "U08JTN5FX39", position: 2 });
  });

  it("matches the requested handle itself", () => {
    expect(findLegalHold(["ops@example.com"], register)?.position).toBe(1);
  });

  it("is case-insensitive on both sides", () => {
    expect(findLegalHold(["OPS@EXAMPLE.COM"], register)?.value).toBe("ops@example.com");
  });

  it("reports the FIRST matching register position, which is what an operator reads", () => {
    const match = findLegalHold(["u08jtn5fx39", "ops@example.com"], register);
    expect(match?.position).toBe(1);
  });

  it("does not match when no alias is held", () => {
    expect(findLegalHold(["someone-else"], register)).toBeNull();
  });

  it("returns null for an empty register without inspecting the aliases", () => {
    expect(findLegalHold(["ops@example.com"], [])).toBeNull();
  });

  it("REFUSES to let a blank handle match a register entry", () => {
    expect(findLegalHold(["", ""], [""])).toBeNull();
  });
});

describe("legalHoldReference", () => {
  const digest = "0123456789abcdef0123456789abcdef";

  it("names a position and a truncated digest, never the entry", () => {
    const reference = legalHoldReference({ value: "ops@example.com", position: 2 }, digest);
    expect(reference).toBe(`${LEGAL_HOLD_REFERENCE_PREFIX}2:${digest.slice(0, LEGAL_HOLD_REFERENCE_DIGEST_LENGTH)}`);
    expect(reference).not.toContain("ops@example.com");
  });

  it("truncates, because this is an identifier to recognize and not a secret", () => {
    const reference = legalHoldReference({ value: "x", position: 1 }, digest);
    expect(reference).not.toContain(digest);
    expect(reference.endsWith(digest.slice(0, LEGAL_HOLD_REFERENCE_DIGEST_LENGTH))).toBe(true);
  });

  it("is recognizable as a reference rather than as a raw entry", () => {
    expect(isLegalHoldReference(legalHoldReference({ value: "x", position: 1 }, digest))).toBe(true);
    expect(isLegalHoldReference("ops@example.com")).toBe(false);
  });
});
