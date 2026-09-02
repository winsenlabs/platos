import { describe, expect, it } from "vitest";

import {
  canonicalToolDocument,
  inferToolCategory,
  parameterNames,
  searchDocument,
  SCHEMA_HASH_LENGTH,
  toSchemaHash,
  TOOL_KINDS,
} from "./tool.js";

describe("the canonical document a schema hash is taken over", () => {
  it("is blind to the order the keys arrived in", () => {
    const left = canonicalToolDocument({
      name: "github.create_issue",
      description: "open an issue",
      paramSchema: { properties: { title: { type: "string" }, body: { type: "string" } } },
      category: "github",
    });
    const right = canonicalToolDocument({
      category: "github",
      paramSchema: { properties: { body: { type: "string" }, title: { type: "string" } } },
      description: "open an issue",
      name: "github.create_issue",
    });
    expect(left).toBe(right);
  });

  it("separates two tools whose only difference is one nested type", () => {
    const before = canonicalToolDocument({
      name: "t",
      description: "",
      paramSchema: { properties: { n: { type: "string" } } },
      category: "c",
    });
    const after = canonicalToolDocument({
      name: "t",
      description: "",
      paramSchema: { properties: { n: { type: "number" } } },
      category: "c",
    });
    expect(before).not.toBe(after);
  });

  it("does not conflate an array with the object holding the same entries", () => {
    expect(canonicalToolDocument({ name: "t", description: "", paramSchema: ["a"], category: "c" })).not.toBe(
      canonicalToolDocument({ name: "t", description: "", paramSchema: { 0: "a" }, category: "c" }),
    );
  });

  it("writes undefined as null, so a JSON round trip does not remint the tool", () => {
    const withUndefined = canonicalToolDocument({
      name: "t",
      description: "",
      paramSchema: { properties: undefined },
      category: "c",
    });
    const roundTripped = canonicalToolDocument({
      name: "t",
      description: "",
      paramSchema: { properties: null },
      category: "c",
    });
    expect(withUndefined).toBe(roundTripped);
  });

  it("preserves array order, which is meaningful in a JSON Schema", () => {
    expect(
      canonicalToolDocument({ name: "t", description: "", paramSchema: { required: ["a", "b"] }, category: "c" }),
    ).not.toBe(
      canonicalToolDocument({ name: "t", description: "", paramSchema: { required: ["b", "a"] }, category: "c" }),
    );
  });
});

describe("narrowing a digest to a schema hash", () => {
  const digest = "0123456789abcdef0123456789abcdef";

  it("takes exactly the declared width", () => {
    const hash = toSchemaHash(digest);
    expect(hash.ok && hash.value).toBe(digest.slice(0, SCHEMA_HASH_LENGTH));
    expect(SCHEMA_HASH_LENGTH).toBe(16);
  });

  it("refuses a digest that is not lowercase hex", () => {
    const upper = toSchemaHash(digest.toUpperCase());
    expect(upper.ok).toBe(false);
    expect(!upper.ok && upper.error.code).toBe("TOOLS_DECLARATION_INVALID");
  });

  it("refuses a digest too short to yield the width, rather than padding it", () => {
    expect(toSchemaHash("0123456789abcde").ok).toBe(false);
    expect(toSchemaHash("0123456789abcdef").ok).toBe(true);
  });
});

describe("the category a tool falls into when nobody said", () => {
  it("prefers the segment before the first dot", () => {
    expect(inferToolCategory("github.create_issue", "acme-backend")).toBe("github");
  });

  it("groups two tools of one namespace even across entities", () => {
    expect(inferToolCategory("github.a", "one")).toBe(inferToolCategory("github.b", "two"));
  });

  it("falls back to the entity, then to the literal entity", () => {
    expect(inferToolCategory("search", "acme-backend")).toBe("acme-backend");
    expect(inferToolCategory("search", "   ")).toBe("entity");
  });

  it("does not treat a leading dot as a namespace", () => {
    expect(inferToolCategory(".hidden", "acme")).toBe("acme");
  });
});

describe("the text a tool is found by", () => {
  it("carries the parameter names, sorted, beside the prose", () => {
    expect(
      searchDocument({
        name: "files.upload",
        description: "put a file somewhere",
        paramSchema: { properties: { path: {}, bucket: {} } },
      }),
    ).toBe("files.upload put a file somewhere bucket path");
  });

  it("reads no names out of an array or a missing properties block", () => {
    expect(parameterNames({ properties: ["a"] })).toEqual([]);
    expect(parameterNames({})).toEqual([]);
  });
});

describe("the tool kinds", () => {
  it("declares exactly the three the schema enum holds", () => {
    expect([...TOOL_KINDS]).toEqual(["ENTITY", "RUNTIME", "META"]);
  });
});
