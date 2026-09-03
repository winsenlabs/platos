import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { asEventName } from "./coercions.js";
import type { SubjectId } from "./identifiers.js";
import { filterAdmits, parseRuleFilter, toRuleFilterInput, type RuleFilter } from "./rule-filter.js";

function filter(eventTypes: string[], subjectIds?: string[]): RuleFilter {
  const parsed = parseRuleFilter({ eventTypes, subjectIds: subjectIds ?? null });
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const subject = (raw: string): SubjectId => asIdentifier<SubjectId>(raw);
const name = asEventName;

describe("parseRuleFilter", () => {
  it("refuses a missing filter object", () => {
    expect(parseRuleFilter(null).ok).toBe(false);
    expect(parseRuleFilter(undefined).ok).toBe(false);
  });

  it("refuses an empty eventTypes array with a field violation", () => {
    const denied = parseRuleFilter({ eventTypes: [] });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_FILTERS_INVALID");
    expect(denied.error.fields[0]?.field).toBe("filters.eventTypes");
  });

  it("propagates a bad pattern rather than accepting a rule that can never match", () => {
    const denied = parseRuleFilter({ eventTypes: ["run.*.failed"] });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_PATTERN_INVALID");
  });

  it("treats an absent subjectIds as an empty allowlist", () => {
    expect(filter(["*"]).subjectIds).toHaveLength(0);
  });

  it("round-trips back to the column shape", () => {
    expect(toRuleFilterInput(filter(["run.*"]))).toEqual({ eventTypes: ["run.*"], subjectIds: null });
    expect(toRuleFilterInput(filter(["run.*"], ["run-1"]))).toEqual({
      eventTypes: ["run.*"],
      subjectIds: ["run-1"],
    });
  });
});

describe("filterAdmits", () => {
  it("admits on a name match with no subject restriction", () => {
    expect(filterAdmits(filter(["run.*"]), name("run.completed"), null)).toBe(true);
    expect(filterAdmits(filter(["run.*"]), name("run.completed"), subject("run-1"))).toBe(true);
  });

  it("refuses on a name miss regardless of subject", () => {
    expect(filterAdmits(filter(["run.*"]), name("tool.called"), subject("run-1"))).toBe(false);
  });

  it("narrows to a listed subject when the allowlist is non-empty", () => {
    const narrowed = filter(["run.*"], ["run-1", "run-2"]);
    expect(filterAdmits(narrowed, name("run.completed"), subject("run-1"))).toBe(true);
    expect(filterAdmits(narrowed, name("run.completed"), subject("run-9"))).toBe(false);
  });

  // The legacy `if (!subjectId) return false`. Reading a null subject as
  // "unconstrained" would send every subjectless event in the environment to a
  // rule that was narrowed to one run.
  it("REFUSES a null subject when the allowlist is non-empty", () => {
    expect(filterAdmits(filter(["run.*"], ["run-1"]), name("run.completed"), null)).toBe(false);
  });

  it("imposes no subject restriction when the allowlist is empty", () => {
    expect(filterAdmits(filter(["*"], []), name("run.completed"), null)).toBe(true);
    expect(filterAdmits(filter(["*"], []), name("run.completed"), subject("anything"))).toBe(true);
  });
});
