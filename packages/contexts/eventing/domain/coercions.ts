// The two places an untrusted string becomes one of this context's branded
// identifiers, gathered so they are greppable.
//
// The kernel's `asIdentifier` is "a compile-time assertion, not validation", and
// its own comment restricts it to "adapters parsing a row, and transports
// parsing a request". `EventName` and `SubjectId` are the two brands that arrive
// from OUTSIDE this context — off a drained envelope — rather than being minted
// inside it, so they need exactly one sanctioned crossing point each. Everything
// else in this domain is either minted here or parsed through a `Result`.

import { asIdentifier } from "@platos/kernel";

import type { EventName, SubjectId } from "./identifiers.js";

/**
 * Brand the envelope's `name`. Deliberately unvalidated: the kernel already
 * fixes the field as "dotted, stable, lower-case", the outbox adapter is its
 * writer, and a drain that refused an unrecognised name would drop events it is
 * required to be forward-compatible with (M0.4 §1.1: "readers ignore unknown
 * event names").
 */
export function asEventName(value: string): EventName {
  return asIdentifier<EventName>(value);
}

/** Brand a subject read off the payload. Its presence is checked by the caller. */
export function asSubjectId(value: string): SubjectId {
  return asIdentifier<SubjectId>(value);
}
