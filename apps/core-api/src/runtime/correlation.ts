// Correlation identity at the PROCESS EDGE.
//
// The kernel's `RequestScope` carries a `requestId` through every layer, and the
// cross-cutting observability gate requires it on every event, span and log
// line. Something has to mint or adopt it at the boundary, once, before any
// business code runs. That is this module, and this is the only place in V1 that
// decides what a request identifier is.
//
// AN INBOUND HEADER IS ATTACKER-CONTROLLED. Adopting it verbatim would let a
// caller inject CRLF into every log line the request touches, forging entries
// that are indistinguishable from real ones, or push a megabyte through every
// span attribute. So an inbound value is ADOPTED ONLY IF IT SURVIVES
// VALIDATION, and is replaced silently otherwise — replaced rather than
// rejected, because a hostile correlation header is not a reason to fail a
// request, only a reason to stop trusting that particular string.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** What travels with one inbound unit of work at the edge. */
export interface CorrelationContext {
  readonly requestId: string;
  /** True when the id came from upstream rather than being minted here. */
  readonly inherited: boolean;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/**
 * The accepted shape. Unreserved URL characters only, so the value is safe in a
 * header, a log field, a span attribute and a URL without escaping anywhere.
 */
const ACCEPTABLE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

/** Adopt an upstream identifier, or return null when it cannot be trusted. */
export function adoptRequestId(raw: unknown): string | null {
  // A repeated header arrives as an array. Two upstream opinions about the
  // identity of one request is itself untrustworthy, so neither is adopted.
  if (typeof raw !== "string") return null;
  return ACCEPTABLE_REQUEST_ID.test(raw) ? raw : null;
}

export function mintRequestId(): string {
  return randomUUID();
}

export function resolveCorrelation(raw: unknown): CorrelationContext {
  const adopted = adoptRequestId(raw);
  return adopted === null
    ? { requestId: mintRequestId(), inherited: false }
    : { requestId: adopted, inherited: true };
}

/** Run `work` with `context` visible to everything it awaits. */
export function withCorrelation<Value>(context: CorrelationContext, work: () => Value): Value {
  return storage.run(context, work);
}

/**
 * The current correlation, or null outside a request.
 *
 * Null rather than a fabricated id: a log line invented outside any request must
 * not claim to belong to one, or correlation stops meaning anything.
 */
export function currentCorrelation(): CorrelationContext | null {
  return storage.getStore() ?? null;
}
