// The guard that keeps an erasure's own records from recreating what it
// destroyed.
//
// Every durable thing this context writes — the operation row, the tombstone
// register, the integration events — documents a person's destruction. Putting
// the person's identifiers into any of them recreates, in a table nobody thinks
// to sweep, exactly the personal data the operation exists to remove. The
// receipt is retained indefinitely as the proof of compliance, so a leak there
// is permanent.
//
// CHECKED RATHER THAN TRUSTED. The tempting thing when debugging is to drop the
// raw id into a note field, and the tempting thing when adding a target is to
// let its error message through. Both are one edit away at all times, so this is
// a mechanical scan rather than a convention.
//
// SCANNED WHOLE, NOT BY FIELD. A record is assembled from an inventory, a set of
// target outcomes, a hold reference and an actor, and the leak arrives through
// whichever of those a later change touches. Serialising the whole value and
// searching it costs one pass and cannot be evaded by adding a field.
//
// The needles are the subject's own handles — the requested id plus every alias
// discovery resolved — which the caller holds in memory and never persists.

import { err, ok, type Result } from "@platos/kernel";

import { receiptWouldLeakSubject } from "./errors.js";

/** Values that must not appear in anything durable, folded once for comparison. */
export function forbiddenNeedles(handles: readonly string[]): readonly string[] {
  const needles = new Set<string>();
  for (const handle of handles) {
    const folded = handle.trim().toLowerCase();
    if (folded !== "") needles.add(folded);
  }
  return [...needles];
}

/**
 * Refuse a value that carries a subject identifier.
 *
 * `what` names the record kind — `"erasure-operation"`, `"erasure-event"` — and
 * is the ONLY thing that reaches the error. The matched needle is deliberately
 * not reported: an error saying which handle leaked would itself carry it into
 * the log the error is written to.
 *
 * Comparison is case-folded on both sides, because the write paths do not agree
 * on casing and a leak spelled with different capitals is still a leak.
 */
export function assertContentFree(what: string, value: unknown, handles: readonly string[]): Result<void> {
  const needles = forbiddenNeedles(handles);
  if (needles.length === 0) return ok(undefined);
  const serialized = JSON.stringify(value ?? null).toLowerCase();
  for (const needle of needles) {
    if (serialized.includes(needle)) return err(receiptWouldLeakSubject(what));
  }
  return ok(undefined);
}
