import { describe, expect, it } from "vitest";

import { assertContentFree, forbiddenNeedles } from "./content-free.js";

const HANDLES = ["walle-1", "Alice@Example.com"];

describe("forbiddenNeedles", () => {
  it("folds and de-duplicates, so one handle is one needle however it was spelled", () => {
    expect(forbiddenNeedles(["A@B.c", " a@b.C ", "a@b.c"])).toEqual(["a@b.c"]);
  });

  it("drops blanks, which would otherwise match every record ever written", () => {
    expect(forbiddenNeedles(["", "   "])).toEqual([]);
  });
});

describe("assertContentFree", () => {
  it("passes a record built only from digests and counts", () => {
    const record = { subjectKeyHash: "d0a1b2c3", deleted: 4, note: "target rejected (E_CODE)" };
    expect(assertContentFree("erasure-operation", record, HANDLES).ok).toBe(true);
  });

  it("REFUSES a record carrying the requested handle", () => {
    const leaked = assertContentFree("erasure-operation", { note: "deleting walle-1" }, HANDLES);
    expect(leaked.ok).toBe(false);
    if (leaked.ok) throw new Error("unreachable");
    expect(leaked.error.code).toBe("PRIVACY_RECEIPT_WOULD_LEAK_SUBJECT");
  });

  it("catches a leak spelled with different capitals", () => {
    expect(assertContentFree("erasure-event", { note: "ALICE@EXAMPLE.COM" }, HANDLES).ok).toBe(false);
  });

  it("scans the WHOLE value, not a chosen subset of fields", () => {
    const nested = { outcomes: [{ target: "files", detail: { reason: "walle-1 not found" } }] };
    expect(assertContentFree("erasure-event", nested, HANDLES).ok).toBe(false);
  });

  it("catches a handle embedded inside a longer string", () => {
    expect(assertContentFree("erasure-event", { note: "user=walle-1;code=X" }, HANDLES).ok).toBe(false);
  });

  it("names the record kind and NOT the matched handle, which would leak it again", () => {
    const leaked = assertContentFree("erasure-event", { note: "walle-1" }, HANDLES);
    if (leaked.ok) throw new Error("unreachable");
    expect(leaked.error.details).toEqual({ what: "erasure-event" });
    expect(JSON.stringify(leaked.error)).not.toContain("walle-1");
  });

  it("passes trivially when there is nothing to look for", () => {
    expect(assertContentFree("erasure-event", { note: "walle-1" }, []).ok).toBe(true);
  });
});
