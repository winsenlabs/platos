// What the analytical sink is doing, in the words an operator needs.
//
// `disabled` and `schema_missing` are DELIBERATELY DIFFERENT WORDS. The first is
// a choice — the product must boot and complete turns with no analytical store
// at all, and an installation that has decided not to have one is not broken.
// The second is an installation that BELIEVES it has one and does not. Reporting
// the second as the first is how a projection pipeline stays broken with nobody
// told, and it is the single failure this vocabulary exists to prevent.
//
// The five states are ordered from "nothing was configured" to "everything
// works", and `available` is true for exactly one of them. Nothing derives
// availability from a string comparison at a call site: `isSinkAvailable` is the
// one predicate, so no surface can privately disagree about what "ready" means.

export const SINK_STATUSES = [
  /** No endpoint configured. A supported configuration, not a fault. */
  "disabled",
  /** An endpoint is configured and the value is not usable. */
  "misconfigured",
  /** Configured and usable, and the store did not answer. */
  "unreachable",
  /** The store answered, and the projection's tables are not there. */
  "schema_missing",
  /** Configured, reachable, and carrying the expected schema. */
  "ready",
] as const;

export type SinkStatus = (typeof SINK_STATUSES)[number];

export interface SinkHealth {
  /** An endpoint was configured. Says NOTHING about whether it works. */
  readonly configured: boolean;
  readonly status: SinkStatus;
  /** One line, safe to log. Never a credential and never a statement body. */
  readonly detail: string;
  /** Tables the probe expected and did not find. Empty unless `schema_missing`. */
  readonly missingTables: readonly string[];
}

/** The one predicate. `available` is never derived at a call site. */
export function isSinkAvailable(health: SinkHealth): boolean {
  return health.status === "ready";
}

/**
 * Whether a drain should claim anything.
 *
 * A drain against an unavailable sink claims nothing and loses nothing: the
 * envelopes stay queued, and claiming them only to fail every one would spend
 * the whole retry budget on an outage the operator already has to fix.
 */
export function shouldDrain(health: SinkHealth): boolean {
  return isSinkAvailable(health);
}

/**
 * How loudly to report a state.
 *
 * `disabled` is `info` because it is a choice. Every other not-working state is
 * `error`, including `misconfigured`: an installation that set the variable has
 * declared it wants a store, and a typo in it is not a warning.
 */
export function healthSeverity(status: SinkStatus): "info" | "warn" | "error" {
  if (status === "ready") return "info";
  if (status === "disabled") return "info";
  if (status === "unreachable") return "warn";
  return "error";
}

export function sinkHealth(
  status: SinkStatus,
  detail: string,
  missingTables: readonly string[] = [],
): SinkHealth {
  return Object.freeze({
    configured: status !== "disabled",
    status,
    detail,
    missingTables: Object.freeze([...missingTables]),
  });
}

/**
 * The health of a sink whose probe THREW.
 *
 * A probe that throws is not evidence the store is absent — it is evidence we
 * learned nothing. `configured: true` is the honest reading: something was set,
 * or there would have been nothing to probe.
 */
export function unreachableSink(errorClass: string): SinkHealth {
  return sinkHealth("unreachable", `health probe threw (${errorClass})`);
}
