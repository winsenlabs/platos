// Schema-shaped turns: admission, precedence, and the one bounded retry.

import { describe, expect, it } from "vitest";

import {
  admitOutputSchema,
  buildCorrection,
  isEmptySchema,
  OUTPUT_PASSES,
  resolveTurnSchema,
} from "./structured-output.js";

const SCHEMA = { type: "object", properties: { answer: { type: "string" } } };

describe("admitOutputSchema", () => {
  it("admits a JSON Schema object", () => {
    const admitted = admitOutputSchema(SCHEMA);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value).toEqual(SCHEMA);
  });

  it("treats null, undefined and `{}` alike as NO schema", () => {
    for (const value of [null, undefined, {}]) {
      const admitted = admitOutputSchema(value);
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) continue;
      expect(admitted.value).toBeNull();
    }
    expect(isEmptySchema({})).toBe(true);
    expect(isEmptySchema(SCHEMA)).toBe(false);
  });

  it("refuses an ARRAY, which is valid JSON and never a schema document", () => {
    const refused = admitOutputSchema([]);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_OUTPUT_SCHEMA_INVALID");
  });

  it("refuses a scalar", () => {
    for (const value of ["a schema", 42, true]) {
      const refused = admitOutputSchema(value);
      expect(refused.ok).toBe(false);
    }
  });
});

describe("resolveTurnSchema", () => {
  it("prefers the per-turn schema over the agent's default", () => {
    const agentDefault = { type: "object", properties: { fallback: {} } };
    expect(resolveTurnSchema(SCHEMA, agentDefault)).toBe(SCHEMA);
  });

  it("falls back to the agent's default when the turn names none", () => {
    const agentDefault = { type: "object", properties: { fallback: {} } };
    expect(resolveTurnSchema(null, agentDefault)).toBe(agentDefault);
  });

  it("treats an EMPTY per-turn schema as absent rather than as an override", () => {
    const agentDefault = { type: "object", properties: { fallback: {} } };
    expect(resolveTurnSchema({}, agentDefault)).toBe(agentDefault);
  });

  it("answers null when neither is set", () => {
    expect(resolveTurnSchema(null, null)).toBeNull();
    expect(resolveTurnSchema({}, {})).toBeNull();
  });
});

describe("buildCorrection", () => {
  it("names the errors and quotes what was answered", () => {
    const correction = buildCorrection('{"answer":1}', ["answer must be a string"]);
    expect(correction).toContain("answer must be a string");
    expect(correction).toContain('{"answer":1}');
    expect(correction).toContain("Answer again, matching the schema exactly.");
  });

  it("reports at most ten errors and says how many it dropped", () => {
    const errors = Array.from({ length: 25 }, (_, index) => `error ${index}`);
    const correction = buildCorrection("{}", errors);
    expect(correction).toContain("error 9");
    expect(correction).not.toContain("error 10");
    expect(correction).toContain("(and 15 more)");
  });

  it("truncates the quoted text, so a bad answer cannot balloon the retry prompt", () => {
    const huge = "z".repeat(10_000);
    const correction = buildCorrection(huge, ["nope"]);
    expect(correction.length).toBeLessThan(5_000);
    expect(correction).toContain("z".repeat(4_000));
    expect(correction).not.toContain("z".repeat(4_001));
  });

  it("says nothing about dropped errors when it dropped none", () => {
    expect(buildCorrection("{}", ["one"])).not.toContain("more)");
  });
});

describe("OUTPUT_PASSES", () => {
  it("is two: the answer, and one repair", () => {
    expect(OUTPUT_PASSES).toBe(2);
  });
});
