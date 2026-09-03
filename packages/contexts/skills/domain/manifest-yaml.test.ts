import { describe, expect, it } from "vitest";

import { findUnquotedColon, findUnquotedHash, parseScalar, parseYamlSubset } from "./manifest-yaml.js";

function parsed(text: string) {
  const result = parseYamlSubset(text);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("findUnquotedHash", () => {
  it("finds a bare hash", () => {
    expect(findUnquotedHash("a: b # note")).toBe(5);
  });

  it("ignores a hash inside double quotes", () => {
    expect(findUnquotedHash('a: "b # c"')).toBe(-1);
  });

  it("ignores a hash inside single quotes", () => {
    expect(findUnquotedHash("a: 'b # c'")).toBe(-1);
  });

  it("finds a hash AFTER a closed quote", () => {
    expect(findUnquotedHash('a: "b" # c')).toBe(7);
  });
});

describe("findUnquotedColon", () => {
  it("finds the separating colon", () => {
    expect(findUnquotedColon("key: value")).toBe(3);
  });

  it("ignores a colon nested inside an inline JSON object", () => {
    expect(findUnquotedColon('schema: {"type": "object"}')).toBe(6);
  });

  it("ignores a colon nested inside an inline JSON array", () => {
    expect(findUnquotedColon('list: [{"a": 1}]')).toBe(4);
  });

  it("ignores a colon inside quotes", () => {
    expect(findUnquotedColon('a: "http://x"')).toBe(1);
  });

  it("reports -1 when there is no separator at all", () => {
    expect(findUnquotedColon("bare text")).toBe(-1);
  });
});

describe("parseScalar", () => {
  it("reads the three literals", () => {
    expect(parseScalar("true")).toBe(true);
    expect(parseScalar("false")).toBe(false);
    expect(parseScalar("null")).toBeNull();
    expect(parseScalar("~")).toBeNull();
  });

  it("reads integers and decimals as numbers", () => {
    expect(parseScalar("42")).toBe(42);
    expect(parseScalar("-7")).toBe(-7);
    expect(parseScalar("1.5")).toBe(1.5);
  });

  it("reads inline JSON before considering it a string", () => {
    expect(parseScalar('{"a":1}')).toEqual({ a: 1 });
    expect(parseScalar("[1,2]")).toEqual([1, 2]);
  });

  it("falls back to a string when inline JSON will not parse", () => {
    expect(parseScalar("{not json}")).toBe("{not json}");
  });

  it("unwraps a quoted string, keeping what it protected", () => {
    expect(parseScalar('"true"')).toBe("true");
    expect(parseScalar('"a b"')).toBe("a b");
  });

  it("reads a version-shaped value as a string, not a number", () => {
    expect(parseScalar("1.2.3")).toBe("1.2.3");
  });
});

describe("parseYamlSubset", () => {
  it("reads a flat map", () => {
    expect(parsed("a: 1\nb: two")).toEqual({ a: 1, b: "two" });
  });

  it("reads a nested map", () => {
    expect(parsed("outer:\n  inner: 1")).toEqual({ outer: { inner: 1 } });
  });

  it("reads a list of scalars", () => {
    expect(parsed("items:\n  - a\n  - b")).toEqual({ items: ["a", "b"] });
  });

  it("reads a list of maps, picking up sibling fields of each item", () => {
    expect(parsed("tools:\n  - name: a\n    description: first\n  - name: b\n    description: second")).toEqual({
      tools: [
        { name: "a", description: "first" },
        { name: "b", description: "second" },
      ],
    });
  });

  it("gives a key with nothing after it and nothing beneath it the value null", () => {
    expect(parsed("a:\nb: 1")).toEqual({ a: null, b: 1 });
  });

  it("strips a trailing comment but keeps the value", () => {
    expect(parsed("a: 1 # why")).toEqual({ a: 1 });
  });

  it("skips blank and comment-only lines entirely", () => {
    expect(parsed("# lead\n\na: 1\n\n# trail")).toEqual({ a: 1 });
  });

  it("REFUSES a line with no separator", () => {
    const result = parseYamlSubset("just words");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("SKILLS_MANIFEST_YAML_MISSING_COLON");
  });

  it("REFUSES an unexpected deeper indent at map level", () => {
    const result = parseYamlSubset("a: 1\n    b: 2");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("SKILLS_MANIFEST_YAML_INDENT");
  });

  it("reports the line number of the offending line, not of the document", () => {
    const result = parseYamlSubset("a: 1\nb: 2\nbroken");
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details.line).toBe(3);
  });

  it("handles carriage returns, so a file authored on another platform parses", () => {
    expect(parsed("a: 1\r\nb: 2")).toEqual({ a: 1, b: 2 });
  });
});
