// EXECUTING THE code -> STATUS MAPPING. This is the file that makes
// `transports/error-status.ts` behaviour rather than a table.
//
// `error-status.ts` has held `CATEGORY_STATUS`, `STATUS_OVERRIDES`,
// `httpStatusFor` and `toWireError` since the taxonomy landed, and until now
// nothing in the process CALLED any of them: the mapping was proved by a unit
// suite and executed by no transport. A mapping no transport executes is a
// mapping that can be wrong in production without a single test going red. This
// module is the execution, and `http/idempotency.ts` is its first caller — over
// a real socket, in the process `runtime/lifecycle.ts` starts.
//
// WHAT GOES ON THE WIRE IS M0.4 §2's ENVELOPE AND NOTHING ELSE:
// `{ error: { code, title, body, errorId, traceRef, version, fields?,
// retryAfterSec? } }`. `toWireError` names every field it copies rather than
// spreading the `DomainError`, so `details` — which the kernel calls "structured
// context for logs, never returned to a client" — cannot reach a caller by
// somebody forgetting. This module adds the two headers the envelope implies
// and writes the bytes.
//
// `Retry-After` IS DERIVED, NOT DECIDED. The kernel populates
// `retryAfterSeconds` only for `rate_limited` and `unavailable`, and a transport
// that invented one for a 409 would be telling a caller to retry a refusal that
// retrying cannot fix.

import { randomUUID } from "node:crypto";

import type { DomainError } from "@platos/kernel";

import { httpStatusFor, toWireError } from "../transports/error-status.js";

/**
 * The wire contract's identity, as M0.4 §1 defines it.
 *
 * THE MAJOR, NOT THE BUILD. §1.2: "V1" is the major, and it is what
 * `error.version` names — a caller branching on `error.code` needs to know which
 * major froze that code, and the major is the thing that is frozen. The BUILD id
 * is a different fact travelling in a different place (`X-Platos-Contract-Version`
 * and the OpenAPI `info.version`), and WIN-267 serves it when it serves the
 * routes. Putting a build id here would make the envelope's `version` change on
 * every release, which is exactly what an immutable major must not do.
 */
export const CONTRACT_VERSION = "1";

/** Only what this module writes to. Structural, so the process edge holds no
 * framework-specific response type — the same reason `health.controller.ts`
 * types its request that way. */
export interface FailureResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
}

export interface FailureIdentity {
  /** This failure's own id. Distinct from the request id: one request can fail
   * more than once, and an operator searching a log for the id a caller quoted
   * must land on one line. */
  readonly errorId: string;
  readonly requestId: string;
}

/** A failure id. UUID rather than ULID because it identifies an incident rather
 * than ordering a row, and `runtime/correlation.ts` already mints the request's
 * own identifier the same way. */
export function mintErrorId(): string {
  return randomUUID();
}

/**
 * Write `error` as M0.4 §2's failure envelope, at the status the taxonomy says.
 *
 * The status comes from `httpStatusFor`, which reads `STATUS_OVERRIDES` then
 * `CATEGORY_STATUS`. `scripts/error-taxonomy.mjs` E4 compares what that function
 * resolves for every one of the four hundred codes against
 * `docs/error-taxonomy.json`, so the number written here is joined to a
 * committed artifact rather than to this module's own opinion.
 */
export function writeFailure(
  response: FailureResponse,
  error: DomainError,
  identity: FailureIdentity,
): number {
  const status = httpStatusFor(error);
  const envelope = toWireError(error, {
    errorId: identity.errorId,
    requestId: identity.requestId,
    contractVersion: CONTRACT_VERSION,
  });
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (envelope.retryAfterSec !== undefined) {
    response.setHeader("Retry-After", String(envelope.retryAfterSec));
  }
  response.end(JSON.stringify({ error: envelope }));
  return status;
}
