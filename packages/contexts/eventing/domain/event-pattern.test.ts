import { describe, expect, it } from "vitest";

import { asEventName } from "./coercions.js";
import {
  anyPatternMatches,
  classifyPattern,
  parsePattern,
  patternMatches,
  type EventPattern,
} from "./event-pattern.js";

function pattern(raw: string): EventPattern {
  const parsed = parsePattern(raw);
  if (!parsed.ok) throw new Error(`${parsed.error.code}: ${raw}`);
  return parsed.value;
}

const name = asEventName;

describe("parsePattern", () => {
  it("accepts the three legacy forms", () => {
    expect(classifyPattern(pattern("*"))).toEqual({ kind: "all" });
    expect(classifyPattern(pattern("run.*"))).toEqual({ kind: "prefix", prefix: "run" });
    expect(classifyPattern(pattern("run.completed"))).toEqual({ kind: "exact", name: "run.completed" });
  });

  it("REFUSES a star the matcher does not implement, rather than silently never matching", () => {
    const denied = parsePattern("run.*.failed");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_PATTERN_INVALID");
  });

  it("refuses an empty pattern", () => {
    expect(parsePattern("").ok).toBe(false);
  });
});

describe("patternMatches", () => {
  it('"*" admits every name', () => {
    expect(patternMatches(pattern("*"), name("run.completed"))).toBe(true);
    expect(patternMatches(pattern("*"), name("budget.exceeded"))).toBe(true);
  });

  it("an exact pattern admits only that name", () => {
    const exact = pattern("run.completed");
    expect(patternMatches(exact, name("run.completed"))).toBe(true);
    expect(patternMatches(exact, name("run.completedish"))).toBe(false);
    expect(patternMatches(exact, name("run.failed"))).toBe(false);
  });

  it("a prefix pattern admits descendants", () => {
    const prefix = pattern("run.*");
    expect(patternMatches(prefix, name("run.completed"))).toBe(true);
    expect(patternMatches(prefix, name("run.step.started"))).toBe(true);
  });

  // The legacy disjunction's second arm. Deleting `|| eventName === prefix`
  // leaves every other case in this file green and turns exactly this one red.
  it('"run.*" ALSO admits the bare name "run" — the legacy second arm', () => {
    expect(patternMatches(pattern("run.*"), name("run"))).toBe(true);
  });

  // The segment anchor. Comparing against the bare prefix instead of `prefix.`
  // is the classic prefix-confusion defect and this is the case that catches it.
  it('"run.*" does NOT admit "runner.started" — the anchor is a segment boundary', () => {
    expect(patternMatches(pattern("run.*"), name("runner.started"))).toBe(false);
    expect(patternMatches(pattern("run.*"), name("runs.started"))).toBe(false);
  });

  it("a prefix pattern does not admit an ancestor or a sibling", () => {
    expect(patternMatches(pattern("run.step.*"), name("run.completed"))).toBe(false);
  });
});

describe("anyPatternMatches", () => {
  it("admits when any one pattern admits", () => {
    const patterns = [pattern("budget.exceeded"), pattern("run.*")];
    expect(anyPatternMatches(patterns, name("run.failed"))).toBe(true);
    expect(anyPatternMatches(patterns, name("budget.exceeded"))).toBe(true);
    expect(anyPatternMatches(patterns, name("tool.called"))).toBe(false);
  });

  // "Empty array = match nothing", straight from the legacy comment. The
  // opposite reading turns an empty rule into a firehose.
  it("an EMPTY pattern list matches NOTHING, not everything", () => {
    expect(anyPatternMatches([], name("run.completed"))).toBe(false);
    expect(anyPatternMatches([], name("anything.at.all"))).toBe(false);
  });
});
