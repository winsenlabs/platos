// Event-name patterns — the matcher at the centre of this context.
//
// PRESERVED VERBATIM from `apps/agent/src/mcp-platform/events.service.ts`
// (`matchesFilters`). This is a refactor, so the three accepted forms and their
// exact reach are reproduced, not redesigned:
//
//   "*"          matches every event name.
//   "run.failed" matches that name and nothing else.
//   "run.*"      matches every name under the `run.` prefix AND the bare prefix
//                `run` itself.
//
// THAT LAST CLAUSE IS NOT A TYPO. The legacy matcher reads
//
//     return eventType.startsWith(`${prefix}.`) || eventType === prefix;
//
// so `run.*` matches the name `run`. It is surprising enough that a reader would
// "fix" it, and fixing it would silently stop delivering an event class that
// operators have live rules for. It is pinned by a test that names it.
//
// A `.*` pattern is anchored at a SEGMENT boundary, which is the property that
// keeps `run.*` from matching `runner.started`. The legacy code gets this right
// by appending the dot before comparing, and the test suite pins it, because the
// obvious "optimisation" — comparing against the bare prefix — is the classic
// prefix-confusion defect.

import { err, ok, type Result } from "@platos/kernel";

import { rulePatternInvalid } from "./errors.js";
import type { EventName } from "./identifiers.js";

/** The wildcard that matches every event name. */
export const MATCH_ALL = "*";

/** The suffix that makes a pattern a prefix match. */
export const PREFIX_SUFFIX = ".*";

/**
 * A validated pattern. Branding it is what stops an unvalidated operator string
 * reaching `patternMatches`, which would otherwise accept anything at all
 * because an unrecognised pattern simply never matches.
 */
export type EventPattern = string & { readonly __eventPattern: unique symbol };

/**
 * The three shapes a pattern may take, made explicit so `patternMatches` is a
 * total function over a closed set rather than a chain of string tests with an
 * implicit "otherwise false" that hides a typo forever.
 */
export type ParsedPattern =
  | { readonly kind: "all" }
  | { readonly kind: "prefix"; readonly prefix: string }
  | { readonly kind: "exact"; readonly name: string };

export function parsePattern(raw: string): Result<EventPattern> {
  if (typeof raw !== "string" || raw.length === 0) {
    return err(rulePatternInvalid(raw, "an event pattern must be a non-empty string"));
  }
  if (raw !== MATCH_ALL && raw.includes(MATCH_ALL) && !raw.endsWith(PREFIX_SUFFIX)) {
    // A star anywhere other than the whole pattern or its `.*` tail is not a
    // form the matcher implements. Accepting it would produce a rule that
    // matches nothing while looking to its author like it matches something —
    // the failure mode a silent "otherwise false" creates.
    return err(
      rulePatternInvalid(raw, 'a "*" is only meaningful as the whole pattern or as a trailing ".*"'),
    );
  }
  return ok(raw as EventPattern);
}

export function classifyPattern(pattern: EventPattern): ParsedPattern {
  if (pattern === MATCH_ALL) return { kind: "all" };
  if (pattern.endsWith(PREFIX_SUFFIX)) {
    return { kind: "prefix", prefix: pattern.slice(0, -PREFIX_SUFFIX.length) };
  }
  return { kind: "exact", name: pattern };
}

/**
 * Does one pattern admit one event name?
 *
 * The `prefix` arm reproduces the legacy disjunction exactly: the segment-
 * anchored descendant test, OR equality with the bare prefix.
 */
export function patternMatches(pattern: EventPattern, eventName: EventName): boolean {
  const parsed = classifyPattern(pattern);
  if (parsed.kind === "all") return true;
  if (parsed.kind === "exact") return parsed.name === eventName;
  return eventName.startsWith(`${parsed.prefix}.`) || eventName === parsed.prefix;
}

/**
 * Does ANY pattern in the list admit the name?
 *
 * An EMPTY list matches NOTHING. The legacy comment says so — "Empty array =
 * match nothing" — and the guard is load-bearing: the natural reading of "no
 * filters" is "no restriction", and an implementation that took that reading
 * would turn every empty rule into a firehose pointed at an operator's webhook.
 */
export function anyPatternMatches(
  patterns: readonly EventPattern[],
  eventName: EventName,
): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => patternMatches(pattern, eventName));
}
