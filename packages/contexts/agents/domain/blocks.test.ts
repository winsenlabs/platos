import { describe, expect, it } from "vitest";

import {
  coerceBlockList,
  mergeJsonConfig,
  objectsIn,
  readPromptBlocks,
  serializePromptBlocks,
  UNHEADED_BLOCK_TYPE,
  UNRENDERED_BLOCK_TYPE,
  type PromptBlock,
} from "./blocks.js";

function block(overrides: Partial<PromptBlock> = {}): PromptBlock {
  return {
    id: "b1",
    type: "section",
    name: "Tone",
    content: "Be brief.",
    enabled: true,
    editable: true,
    order: 0,
    ...overrides,
  };
}

describe("the write-boundary coercion", () => {
  it("passes an already-correct array through, as a copy", () => {
    const list = [{ a: 1 }];
    const coerced = coerceBlockList(list);
    expect(coerced).toEqual(list);
    expect(coerced).not.toBe(list);
  });

  it("parses a DOUBLE-ENCODED array back into an array", () => {
    // The corruption this exists for: a client that serialized the field lands a
    // string in a jsonb column, and every downstream reader assumes an array.
    expect(coerceBlockList(JSON.stringify([{ a: 1 }]))).toEqual([{ a: 1 }]);
  });

  it("drops a string that is not JSON at all to null", () => {
    expect(coerceBlockList("not json")).toBeNull();
  });

  it("drops a JSON scalar and a JSON object to null, because neither is a list", () => {
    expect(coerceBlockList('"a string"')).toBeNull();
    expect(coerceBlockList('{"a":1}')).toBeNull();
    expect(coerceBlockList({ a: 1 })).toBeNull();
  });

  it("reads an empty string as an absent list", () => {
    expect(coerceBlockList("   ")).toBeNull();
  });

  it("treats null and undefined as the same answer", () => {
    expect(coerceBlockList(null)).toBeNull();
    expect(coerceBlockList(undefined)).toBeNull();
  });

  it("is idempotent, which is what lets a legacy row self-heal on its next save", () => {
    const once = coerceBlockList(JSON.stringify([{ a: 1 }]));
    expect(coerceBlockList(once)).toEqual(once);
  });

  it("keeps an empty array as an empty array, not as null", () => {
    expect(coerceBlockList([])).toEqual([]);
  });
});

describe("objectsIn", () => {
  it("keeps objects and drops scalars, arrays and nulls", () => {
    expect(objectsIn([{ a: 1 }, 2, "x", null, [3]])).toEqual([{ a: 1 }]);
  });

  it("answers empty for an absent list", () => {
    expect(objectsIn(null)).toEqual([]);
  });
});

describe("reading blocks", () => {
  it("defaults an ABSENT enabled flag to true, so a pre-flag block still renders", () => {
    const blocks = readPromptBlocks([{ id: "b1", type: "section", name: "T", content: "c" }]);
    expect(blocks?.[0]?.enabled).toBe(true);
  });

  it("honours an explicit false", () => {
    const blocks = readPromptBlocks([{ id: "b1", content: "c", enabled: false }]);
    expect(blocks?.[0]?.enabled).toBe(false);
  });

  it("defaults a missing order to 0 rather than to undefined", () => {
    expect(readPromptBlocks([{ id: "b1", content: "c" }])?.[0]?.order).toBe(0);
  });

  it("answers null for a column that holds no list", () => {
    expect(readPromptBlocks("not json")).toBeNull();
  });
});

describe("serialization", () => {
  it("orders by the declared order, not by array position", () => {
    const rendered = serializePromptBlocks([
      block({ name: "Second", content: "two", order: 2 }),
      block({ name: "First", content: "one", order: 1 }),
    ]);
    expect(rendered).toBe("## First\n\none\n\n## Second\n\ntwo");
  });

  it("does not reorder the caller's array", () => {
    const blocks = [block({ name: "B", order: 2 }), block({ name: "A", order: 1 })];
    serializePromptBlocks(blocks);
    expect(blocks.map((held) => held.name)).toEqual(["B", "A"]);
  });

  it("drops a disabled block", () => {
    expect(serializePromptBlocks([block({ enabled: false })])).toBe("");
  });

  it("drops a block whose content is blank", () => {
    expect(serializePromptBlocks([block({ content: "   " })])).toBe("");
  });

  it("drops a retrieval block, whose body names material rather than being it", () => {
    expect(serializePromptBlocks([block({ type: UNRENDERED_BLOCK_TYPE })])).toBe("");
  });

  it("renders an identity block without a heading", () => {
    expect(serializePromptBlocks([block({ type: UNHEADED_BLOCK_TYPE, content: "You are X." })])).toBe(
      "You are X.",
    );
  });

  it("renders an unnamed block without a heading", () => {
    expect(serializePromptBlocks([block({ name: "", content: "bare" })])).toBe("bare");
  });

  it("trims each rendered body", () => {
    expect(serializePromptBlocks([block({ name: "", content: "  x  " })])).toBe("x");
  });

  it("answers the empty string for no blocks at all", () => {
    expect(serializePromptBlocks(null)).toBe("");
    expect(serializePromptBlocks([])).toBe("");
  });
});

describe("the shallow merge", () => {
  it("keeps stored keys the patch does not carry", () => {
    expect(mergeJsonConfig({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it("treats an explicit null as clear", () => {
    expect(mergeJsonConfig({ a: 1 }, null)).toBeNull();
  });

  it("replaces rather than merges when the patch is not an object", () => {
    expect(mergeJsonConfig({ a: 1 }, "x")).toBe("x");
    expect(mergeJsonConfig({ a: 1 }, [1])).toEqual([1]);
  });

  it("passes the patch through when there is no prior value", () => {
    expect(mergeJsonConfig(null, { a: 1 })).toEqual({ a: 1 });
  });

  it("does not mutate either side", () => {
    const existing = { a: 1 };
    const patch = { b: 2 };
    mergeJsonConfig(existing, patch);
    expect(existing).toEqual({ a: 1 });
    expect(patch).toEqual({ b: 2 });
  });
});
