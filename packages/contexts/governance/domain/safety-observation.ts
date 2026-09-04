// The kernel `SafetyObservation` -> ledger draft translation.
//
// This file IS the `auth -> monitoring` inversion of ADR M0.3 §3. The
// enforcement layer's rate-limit guard used to import `SafetyEventService`
// directly; it now publishes through the kernel `SafetyEventSink`, this context
// implements the sink, and the composition root binds the two. There is no
// identity-access -> governance code edge, and rule (g) `identity-isolation`
// keeps it that way. This module is the only place the kernel's vocabulary and
// the ledger's vocabulary meet.
//
// THEY ARE NOT THE SAME AXIS, AND THE MAPPING IS TOTAL AND LOSSLESS. The kernel
// names an OUTCOME — what happened to the request — while the ledger column
// names an ACTION — what the detector did. `held` has no ledger action of its
// own: a held request was neither allowed through nor blocked, it was parked for
// a human, and the nearest true ledger action is `warn`. Rather than invent a
// fifth stored value that no existing dashboard knows how to render, the mapping
// records the kernel's own word verbatim on the draft's `rule` and in the
// event's metadata, so nothing is lost and a reader can recover the exact
// outcome. Every one of the four outcomes maps, so a sink call can never fail
// for want of a translation.
//
// THE DETECTOR COMES FROM THE RULE IDENTITY, NOT FROM A GUESS. The kernel port
// documents `rule` as a "stable, dotted rule identity" and gives
// `identity.rate_limit.exceeded` as its example. That is
// `<producer>.<detector>.<verdict>`, so the detector is the SECOND segment and
// is looked up in the ledger's closed set. A rule with fewer than three
// non-empty segments is refused as malformed, and a well-formed rule naming a
// detector the ledger has no bucket for is refused as unknown — two codes,
// because a producer that never adopted the format and a producer naming a
// detector nobody registered are different bugs with different fixes.
//
// A REFUSAL HERE DOES NOT REACH THE CALLER. The kernel port requires `record`
// not to throw and not to block the caller's decision, so the sink swallows
// these refusals, writes nothing, and reports them through the `Logger` port.
// That is `application/safety-event-sink.ts`; this module only decides.

import { err, ok, type JsonValue, type Result, type SafetyObservation, type SafetyOutcome } from "@platos/kernel";

import { safetyDetectorUnknown, safetyRuleMalformed } from "./errors.js";
import { isSafetyDetector, type SafetyAction, type SafetyDetector, type SafetyEventDraft, type SafetySeverity } from "./safety-event.js";

/**
 * The outcome -> action map, total over `SafetyOutcome`.
 *
 * Written as a record rather than a switch so the exhaustiveness is a property
 * of the type rather than of a default branch nobody exercises.
 */
export const OUTCOME_ACTIONS: Readonly<Record<SafetyOutcome, SafetyAction>> = Object.freeze({
  allowed: "flag",
  blocked: "block",
  held: "warn",
  redacted: "redact",
});

/**
 * The outcome -> severity map, also total.
 *
 * A blocked request and a held one are both `high` because both stopped a caller
 * getting what it asked for; a redaction is `medium` because the caller was
 * served, minus something; an observation that allowed the request through is
 * `low` because nothing was withheld. The ledger's severity column is what
 * operators alert on, so the map is stated once here rather than being decided
 * again by each producer.
 */
export const OUTCOME_SEVERITIES: Readonly<Record<SafetyOutcome, SafetySeverity>> = Object.freeze({
  allowed: "low",
  blocked: "high",
  held: "high",
  redacted: "medium",
});

/** The rule identity, split. */
export interface RuleIdentity {
  readonly producer: string;
  readonly detector: SafetyDetector;
  readonly verdict: string;
}

/**
 * Split a dotted rule identity and resolve its detector.
 *
 * A fourth segment and beyond is kept on the verdict rather than refused: rule
 * identities grow suffixes over time (`identity.rate_limit.exceeded.burst`) and
 * refusing one would drop a safety signal over a naming convention.
 */
export function parseRuleIdentity(rule: string): Result<RuleIdentity> {
  const segments = rule.split(".");
  if (segments.length < 3) return err(safetyRuleMalformed(rule));
  if (segments.some((segment) => segment.trim() === "")) return err(safetyRuleMalformed(rule));
  const producer = segments[0] as string;
  const detector = segments[1] as string;
  if (!isSafetyDetector(detector)) return err(safetyDetectorUnknown(detector));
  return ok({ producer, detector, verdict: segments.slice(2).join(".") });
}

/**
 * Turn one kernel observation into a ledger draft.
 *
 * `details` arrives "already redacted by the producer" per the port, so it is
 * carried through untouched into the row's metadata, joined by the outcome and
 * the producer so the kernel's own words survive the mapping.
 */
export function draftFromObservation(observation: SafetyObservation): Result<SafetyEventDraft> {
  const identity = parseRuleIdentity(observation.rule);
  if (!identity.ok) return err(identity.error);
  const metadata: Record<string, JsonValue> = {
    ...observation.details,
    __outcome: observation.outcome,
    __producer: identity.value.producer,
    __verdict: identity.value.verdict,
  };
  return ok({
    detector: identity.value.detector,
    action: OUTCOME_ACTIONS[observation.outcome],
    severity: OUTCOME_SEVERITIES[observation.outcome],
    detail: null,
    metadata,
    principalId: observation.principalId,
    rule: observation.rule,
  });
}
