// The code -> status mapping, and the M0.4 §2 failure envelope.
//
// The kernel's `vo/error.ts` closes with "the code -> HTTP-status / RPC-code
// mapping tables belong to WIN-260". This is that table. It lives here, in
// `transports/`, because ADR M0.3 §2 keeps the domain free of transport
// vocabulary: a context says `not_found`, and only this file knows that means
// 404. Every context's `domain/errors.ts` records the live status of an
// inherited code as a COMMENT for exactly this reason — the comment is where the
// number came from, and this is where it becomes behaviour.
//
// TWO LAYERS, AND THE SECOND IS SMALL ON PURPOSE.
//
//   `CATEGORY_STATUS` is total over the kernel's `ErrorCategory` union and is
//   what almost every code resolves through. Written as a `Record<ErrorCategory,
//   number>` so the COMPILER refuses a category that has no status and a status
//   for a category that does not exist — the mapping cannot be partial.
//
//   `STATUS_OVERRIDES` is the exceptions, per CODE. It exists because the live
//   surface really is finer than nine categories: `JOB_TIMEOUT` is `unavailable`
//   and answers 504 rather than 503, and `JOB_NOT_REGISTERED` is
//   `precondition_failed` and answers 422 rather than 412. Deriving those from
//   the category would lose them; putting all four hundred codes in a table
//   would make the table impossible to read and impossible to keep true.
//
// WHY A SHARED STATUS IS FINE AND A SHARED CODE IS NOT. Four `jobs` codes answer 409
// — `IDEMPOTENCY_CONFLICT` and the three unreadable-reservation refusals — and
// that is correct: they are one instruction to the caller ("this request id is
// spoken for; a retry with the same id will not help"). What differs is what an
// OPERATOR must do, and that travels in `error.code`, which M0.4 §2 makes
// immutable within a major precisely so it can be branched on. A transport that
// collapsed them would be discarding the only field that distinguishes them.
//
// `scripts/error-taxonomy.mjs` joins this file to `docs/error-taxonomy.json` and
// to the 17 contexts' mint sites, so a code added anywhere without a mapping,
// and a mapping here for a code nobody mints, both fail CI.

import type { DomainError, ErrorCategory } from "@platos/kernel";

/** The status a code of each category answers with when nothing says otherwise. */
export const CATEGORY_STATUS: Record<ErrorCategory, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  // 412 rather than 428: `precondition_failed` here means a state precondition
  // the caller can observe and fix, not a missing `If-Match`.
  precondition_failed: 412,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

/**
 * The codes whose status is NOT their category's default.
 *
 * Every entry is a status the extraction recorded from the live service, quoted
 * beside the code in its context's `domain/errors.ts`. This is not a place to
 * express a preference: a code that wants a different status than its category
 * usually wants a different category.
 */
export const STATUS_OVERRIDES: Record<string, number> = {
  // `jobs`, from the live `JobExecutionErrorCode` surface.
  JOB_NOT_REGISTERED: 422,
  JOB_RESULT_REJECTED: 422,
  JOB_TIMEOUT: 504,
};

/**
 * The JSON-RPC code an MCP transport answers with, per category.
 *
 * THE CANONICAL CODE DOES NOT LIVE HERE. JSON-RPC has four reserved slots and
 * this system has four hundred codes, so any category mapping collapses most of
 * them onto -32603. That is survivable ONLY because the canonical code travels
 * in `data.code` on the same frame: a caller that must tell `JOB_TIMEOUT` from
 * `JOBS_REPOSITORY_UNAVAILABLE` reads the field M0.4 §2 froze, not the RPC
 * number. Recording the collapse here, with that sentence, is the honest form —
 * inventing distinct negative integers per category would imply a distinction
 * the protocol does not carry.
 */
export const RPC_CATEGORY_CODE: Record<ErrorCategory, number> = {
  invalid_input: -32602,
  unauthenticated: -32603,
  forbidden: -32603,
  not_found: -32601,
  conflict: -32603,
  precondition_failed: -32603,
  rate_limited: -32603,
  unavailable: -32603,
  internal: -32603,
};

export function httpStatusFor(error: DomainError): number {
  return STATUS_OVERRIDES[error.code] ?? CATEGORY_STATUS[error.category];
}

export function rpcCodeFor(error: DomainError): number {
  return RPC_CATEGORY_CODE[error.category];
}

/** The M0.4 §2 REST failure envelope, minus the transport-supplied identity. */
export interface WireError {
  readonly code: string;
  readonly title: string;
  readonly body: string;
  readonly errorId: string;
  readonly traceRef: string;
  readonly version: string;
  readonly fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[];
  readonly retryAfterSec?: number;
}

/**
 * What the caller is handed.
 *
 * `details` IS NOT IN IT, AND THAT IS THE POINT. The kernel calls `details`
 * "structured, already-redacted context for logs. Never returned to a client",
 * and a builder that spread the whole `DomainError` would put it on the wire the
 * first time somebody forgot. Every field here is named.
 *
 * `errorId` and `traceRef` are supplied rather than minted: the correlation
 * identifier is decided once, at the process edge, by
 * `runtime/correlation.ts`, and a transport that minted a second one would give
 * the caller a reference that appears in no log line.
 */
export function toWireError(
  error: DomainError,
  identity: { readonly errorId: string; readonly requestId: string; readonly contractVersion: string },
): WireError {
  const envelope: {
    code: string;
    title: string;
    body: string;
    errorId: string;
    traceRef: string;
    version: string;
    fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[];
    retryAfterSec?: number;
  } = {
    code: error.code,
    title: error.category,
    body: error.message,
    errorId: identity.errorId,
    traceRef: identity.requestId,
    version: identity.contractVersion,
  };
  if (error.fields.length > 0) envelope.fields = error.fields;
  if (error.retryAfterSeconds !== null) envelope.retryAfterSec = error.retryAfterSeconds;
  return envelope;
}
