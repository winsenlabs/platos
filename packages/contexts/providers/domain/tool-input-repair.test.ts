import { describe, expect, it } from "vitest";

import type { JsonSchemaDocument } from "./generation.js";
import { repairToolCallInput } from "./tool-input-repair.js";

/** The schema of the tool whose calls the extraction source saw fail. */
const EXECUTE_TOOLS: JsonSchemaDocument = {
  type: "object",
  properties: {
    calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: { type: "string" },
          params: { type: "object", properties: { body: { type: "string" } } },
        },
      },
    },
  },
};

describe("repairToolCallInput", () => {
  it("unwraps the stringified array the production trace burned three steps on", () => {
    const broken = JSON.stringify({
      calls: '[{"tool": "SEND", "params": {"body": "a\\nb"}}]',
    });

    const repaired = repairToolCallInput(broken, EXECUTE_TOOLS);

    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired as string)).toEqual({
      calls: [{ tool: "SEND", params: { body: "a\nb" } }],
    });
  });

  it("unwraps a nested container inside an already-unwrapped array item", () => {
    const broken = JSON.stringify({
      calls: [{ tool: "SEND", params: '{"body": "hello"}' }],
    });

    const repaired = repairToolCallInput(broken, EXECUTE_TOOLS);

    expect(JSON.parse(repaired as string)).toEqual({
      calls: [{ tool: "SEND", params: { body: "hello" } }],
    });
  });

  it("leaves a legitimate string argument that merely LOOKS like JSON alone", () => {
    // `body` is declared a string, so a body whose text opens with `{` is a
    // body and not a container. This is the case the schema check exists for.
    const intact = JSON.stringify({
      calls: [{ tool: "SEND", params: { body: '{"not": "a container"}' } }],
    });

    expect(repairToolCallInput(intact, EXECUTE_TOOLS)).toBeNull();
  });

  it("refuses to repair with no schema, rather than guessing", () => {
    const broken = JSON.stringify({ calls: '[{"tool": "SEND"}]' });
    expect(repairToolCallInput(broken, undefined)).toBeNull();

    // A TOP-LEVEL string is the case that actually reaches the schema question:
    // with an object the walk stops at the absent `properties` either way, so
    // an assertion on one alone would leave `schemaAllows` free to say yes to
    // everything with every test still green.
    expect(repairToolCallInput(JSON.stringify("[1,2]"), undefined)).toBeNull();
  });

  it("refuses when the schema declares the property a string", () => {
    const stringly: JsonSchemaDocument = {
      type: "object",
      properties: { calls: { type: "string" } },
    };

    expect(repairToolCallInput(JSON.stringify({ calls: "[1,2]" }), stringly)).toBeNull();
  });

  it("accepts an array-typed union member", () => {
    const union: JsonSchemaDocument = {
      type: "object",
      properties: { calls: { type: ["array", "string"] } },
    };

    const repaired = repairToolCallInput(JSON.stringify({ calls: "[1,2]" }), union);

    expect(JSON.parse(repaired as string)).toEqual({ calls: [1, 2] });
  });

  it("treats a schema with `properties` but no `type` as object-shaped", () => {
    const untyped: JsonSchemaDocument = {
      properties: { inner: { properties: { a: { type: "string" } } } },
    };

    const repaired = repairToolCallInput(JSON.stringify({ inner: '{"a":"x"}' }), untyped);

    expect(JSON.parse(repaired as string)).toEqual({ inner: { a: "x" } });
  });

  it("leaves a string that parses to a SCALAR alone", () => {
    // `"7"` parses, but the schema asked for an array, and a number is not one.
    const schema: JsonSchemaDocument = { type: "object", properties: { calls: { type: "array" } } };

    expect(repairToolCallInput(JSON.stringify({ calls: "7" }), schema)).toBeNull();
  });

  it("lets a genuinely malformed container stand as the provider's own failure", () => {
    const schema: JsonSchemaDocument = { type: "object", properties: { calls: { type: "array" } } };

    expect(repairToolCallInput(JSON.stringify({ calls: "[{oops" }), schema)).toBeNull();
  });

  it("returns null when the outer envelope itself is not JSON", () => {
    expect(repairToolCallInput("not json at all", EXECUTE_TOOLS)).toBeNull();
  });

  it("accepts an already-parsed object as well as the wire string", () => {
    const repaired = repairToolCallInput(
      { calls: '[{"tool": "SEND"}]' },
      EXECUTE_TOOLS,
    );

    expect(JSON.parse(repaired as string)).toEqual({ calls: [{ tool: "SEND" }] });
  });

  it("refuses a scalar input, which carries no property to repair", () => {
    expect(repairToolCallInput(7, EXECUTE_TOOLS)).toBeNull();
    expect(repairToolCallInput(null, EXECUTE_TOOLS)).toBeNull();
  });

  it("reports nothing when the call was already the right shape", () => {
    const fine = JSON.stringify({ calls: [{ tool: "SEND", params: { body: "a" } }] });

    expect(repairToolCallInput(fine, EXECUTE_TOOLS)).toBeNull();
  });

  it("returns on a payload deep enough to exhaust the stack without the bound", () => {
    // The bound's whole job, stated as the one thing that is observable about
    // it. A model can emit — and an adversary can send — a payload nested
    // thousands deep, and a walk with no bound descends one frame per level and
    // dies inside the request. With the bound it returns, in bounded time,
    // having repaired nothing below the sixth level.
    const recursive: Record<string, unknown> = { type: "array" };
    recursive.items = recursive;

    let deep = "[]";
    for (let level = 0; level < 40_000; level += 1) deep = `[${deep}]`;

    expect(() => repairToolCallInput(deep, recursive as JsonSchemaDocument)).not.toThrow();
    expect(repairToolCallInput(deep, recursive as JsonSchemaDocument)).toBeNull();
  });

  it("repairs within the bound, so the bound is not simply switching repair off", () => {
    // The control on the case above: at a depth the walk does reach, a
    // string-encoded container IS unwrapped. Without this, a bound of zero would
    // pass the test above just as well.
    const schema: JsonSchemaDocument = {
      type: "object",
      properties: { calls: { type: "array", items: { type: "object" } } },
    };

    const repaired = repairToolCallInput(JSON.stringify({ calls: '[{"a":1}]' }), schema);

    expect(JSON.parse(repaired as string)).toEqual({ calls: [{ a: 1 }] });
  });

  it("leaves an empty string alone", () => {
    const schema: JsonSchemaDocument = { type: "object", properties: { calls: { type: "array" } } };

    expect(repairToolCallInput(JSON.stringify({ calls: "" }), schema)).toBeNull();
  });
});
