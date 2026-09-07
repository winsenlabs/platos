// HOW A `DomainError` REACHES THE EDGE.
//
// The kernel's `vo/error.ts` is explicit that "an error here is a VALUE, not a
// thrown class", and every use case in the seventeen contexts returns
// `Result<T>` rather than throwing. That is the right shape for the domain and
// it is not a shape a framework can route: Nest decides a response from a THROWN
// value, so somewhere between "the use case returned `err`" and "the socket
// carries the envelope" the value has to become an exception. This file is that
// one place, and it is deliberately the only one.
//
// A CLASS, BECAUSE `instanceof` IS NOT WHAT WE MATCH ON. `DomainFault` extends
// `Error` so that a stack is captured for the log line and so that anything in
// the process that treats exceptions as `Error` keeps working. But
// `domainErrorOf` matches STRUCTURALLY, and that is not fussiness: a monorepo
// with two copies of a package in the graph gives two distinct classes with the
// same name, and an `instanceof` check against the wrong one is a silent 500 for
// a refusal the domain expressed perfectly. It also means a transport that
// throws a bare `DomainError` value — the shape the kernel actually blesses —
// is routed just the same.
//
// WHAT THIS FILE IS NOT. It is not a place to build errors: the four the edge
// owns are in `transport-errors.ts` and the other 415 belong to the contexts
// that mint them. It is the carrier and the recogniser, nothing else.

import type { DomainError, ErrorCategory } from "@platos/kernel";

/** The nine categories, as a runtime set. Structural recognition needs one. */
const CATEGORIES: ReadonlySet<string> = new Set<ErrorCategory>([
  "invalid_input",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "precondition_failed",
  "rate_limited",
  "unavailable",
  "internal",
]);

/**
 * A `DomainError` on its way to the exception filter.
 *
 * `message` is the domain error's message so that a log line, a debugger and a
 * stack trace all say the same thing the caller was told. `cause` is left alone:
 * a fault carries a decision, not a failure of something else.
 */
export class DomainFault extends Error {
  readonly error: DomainError;

  constructor(error: DomainError) {
    super(`${error.code}: ${error.message}`);
    this.name = "DomainFault";
    this.error = error;
  }
}

/** True when `value` is shaped like the kernel's `DomainError`. */
export function isDomainError(value: unknown): value is DomainError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DomainError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.category === "string" &&
    CATEGORIES.has(candidate.category) &&
    typeof candidate.message === "string" &&
    Array.isArray(candidate.fields) &&
    (candidate.retryAfterSeconds === null || typeof candidate.retryAfterSeconds === "number") &&
    typeof candidate.details === "object" &&
    candidate.details !== null
  );
}

/**
 * The `DomainError` inside a thrown value, or null when there is not one.
 *
 * Null is the interesting answer: it is what separates "the domain refused" from
 * "something broke", and the two must not produce the same response. The filter
 * turns the first into the code the caller can branch on and the second into
 * `TRANSPORT_UNHANDLED_FAULT` plus a log line an operator can chase.
 */
export function domainErrorOf(thrown: unknown): DomainError | null {
  if (thrown instanceof DomainFault) return thrown.error;
  if (isDomainError(thrown)) return thrown;
  // A `DomainFault` from a second copy of this module in the graph. Recognised
  // by the property it carries rather than by its class, for the reason in the
  // banner.
  if (typeof thrown === "object" && thrown !== null && "error" in thrown) {
    const carried = (thrown as { readonly error: unknown }).error;
    if (isDomainError(carried)) return carried;
  }
  return null;
}

/**
 * Refuse, from inside a handler.
 *
 * `never` rather than `void` so that a caller writing
 * `if (!result.ok) raise(result.error);` gets the narrowing for free and does
 * not have to write a `return` the compiler cannot check.
 */
export function raise(error: DomainError): never {
  throw new DomainFault(error);
}
