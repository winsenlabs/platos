// A rule's matching half: which events it wants.
//
// The legacy shape is `{ eventTypes: string[]; subjectIds?: string[] }` stored
// in `NotificationRule.filters` (a `Json` column, so nothing in the schema
// constrains it). Parsing it into a value object HERE is what turns "the column
// might contain anything" into a single place that decides what it contains.
//
// TWO PREDICATES, AND THE ORDER MATTERS. A filter admits an event when its
// patterns admit the NAME and its subject allowlist admits the SUBJECT. An
// absent or empty allowlist imposes no subject restriction; a non-empty one
// requires a subject to be present AND listed. That asymmetry against
// `eventTypes` — where empty means "match nothing" — is deliberate in the
// original and is preserved: `eventTypes` is the rule's reason to exist, and
// `subjectIds` is an optional narrowing of it.

import { err, ok, type Result } from "@platos/kernel";

import { ruleFiltersInvalid } from "./errors.js";
import { anyPatternMatches, parsePattern, type EventPattern } from "./event-pattern.js";
import type { EventName, SubjectId } from "./identifiers.js";

export interface RuleFilter {
  readonly eventPatterns: readonly EventPattern[];
  /** Empty means "no subject restriction", never "match no subject". */
  readonly subjectIds: readonly SubjectId[];
}

/** The unparsed column shape, as an adapter or a transport hands it over. */
export interface RuleFilterInput {
  readonly eventTypes: readonly string[];
  readonly subjectIds?: readonly string[] | null;
}

export function parseRuleFilter(input: RuleFilterInput | null | undefined): Result<RuleFilter> {
  if (input === null || input === undefined || typeof input !== "object") {
    return err(ruleFiltersInvalid("filters must be an object with an eventTypes array"));
  }
  const { eventTypes } = input;
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
    return err(
      ruleFiltersInvalid("filters.eventTypes must be a non-empty array", [
        { field: "filters.eventTypes", code: "required", message: "at least one event pattern is required" },
      ]),
    );
  }
  const eventPatterns: EventPattern[] = [];
  for (const raw of eventTypes) {
    const parsed = parsePattern(raw);
    if (!parsed.ok) return err(parsed.error);
    eventPatterns.push(parsed.value);
  }
  const subjectIds = (input.subjectIds ?? []) as readonly SubjectId[];
  if (!Array.isArray(subjectIds)) {
    return err(ruleFiltersInvalid("filters.subjectIds must be an array when present"));
  }
  return ok(Object.freeze({ eventPatterns: Object.freeze([...eventPatterns]), subjectIds: Object.freeze([...subjectIds]) }));
}

/**
 * Does this filter admit this event?
 *
 * A subject allowlist with entries requires a subject: an event carrying `null`
 * is NOT admitted. The legacy code is explicit — `if (!subjectId) return false`
 * — and the alternative (treating a null subject as unconstrained) would let a
 * rule narrowed to one run receive every subjectless event in the environment.
 */
export function filterAdmits(
  filter: RuleFilter,
  eventName: EventName,
  subjectId: SubjectId | null,
): boolean {
  if (!anyPatternMatches(filter.eventPatterns, eventName)) return false;
  if (filter.subjectIds.length === 0) return true;
  if (subjectId === null) return false;
  return filter.subjectIds.includes(subjectId);
}

/** Back to the column shape, for an adapter that must write the `Json` value. */
export function toRuleFilterInput(filter: RuleFilter): RuleFilterInput {
  return {
    eventTypes: [...filter.eventPatterns],
    subjectIds: filter.subjectIds.length === 0 ? null : [...filter.subjectIds],
  };
}
