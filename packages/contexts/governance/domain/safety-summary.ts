// The detector-hit rollup the governance dashboard reads.
//
// A PURE FOLD OVER ADMITTED ROWS, which is the whole reason the vocabulary is a
// closed set. The source folds over raw strings, so `"pii"` and `"PII"` are two
// buckets and a dashboard shows two phenomena where there is one. Here the
// buckets are DECLARED — every detector, action and severity the ledger knows
// gets a key, present at zero — so a reader can tell "no injection events" from
// "injection is not a thing this build detects", and a chart's series do not
// appear and disappear as traffic changes.
//
// The source's `summary()` also returns `total: rows.length`, which is the
// number of rows it read rather than the number in the window: it reads without
// a limit today, so the two agree by accident. Here the count that is summed is
// the count that is reported, and the reader passes a page it chose.

import {
  SAFETY_ACTIONS,
  SAFETY_DETECTORS,
  SAFETY_SEVERITIES,
  type SafetyAction,
  type SafetyDetector,
  type SafetySeverity,
} from "./safety-event.js";

/** One row, reduced to the three axes a rollup counts along. */
export interface SafetyTally {
  readonly detector: SafetyDetector;
  readonly action: SafetyAction;
  readonly severity: SafetySeverity;
}

export interface SafetySummary {
  readonly total: number;
  readonly byDetector: Readonly<Record<SafetyDetector, number>>;
  readonly byAction: Readonly<Record<SafetyAction, number>>;
  readonly bySeverity: Readonly<Record<SafetySeverity, number>>;
}

function zeroed<Key extends string>(keys: readonly Key[]): Record<Key, number> {
  const counts = {} as Record<Key, number>;
  for (const key of keys) counts[key] = 0;
  return counts;
}

/** Fold rows into the three declared histograms. */
export function summarise(rows: readonly SafetyTally[]): SafetySummary {
  const byDetector = zeroed(SAFETY_DETECTORS);
  const byAction = zeroed(SAFETY_ACTIONS);
  const bySeverity = zeroed(SAFETY_SEVERITIES);
  for (const row of rows) {
    byDetector[row.detector] += 1;
    byAction[row.action] += 1;
    bySeverity[row.severity] += 1;
  }
  return {
    total: rows.length,
    byDetector: Object.freeze(byDetector),
    byAction: Object.freeze(byAction),
    bySeverity: Object.freeze(bySeverity),
  };
}
