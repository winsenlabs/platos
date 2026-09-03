// Canonical errors.
//
// M0.4 §2 fixes the wire envelope: `{ error: { code, title, body, errorId,
// traceRef, version, fields?, retryAfterSec? } }`, with `code` a SCREAMING_SNAKE
// string that is immutable within a major. That is the REST expression. This is
// the domain expression the transports map FROM, so REST, MCP, stream and
// workflow surfaces cannot privately disagree about what went wrong. The
// code -> HTTP-status / RPC-code mapping tables belong to WIN-260.
//
// An error here is a VALUE, not a thrown class. ADR M0.3 §5.3 forbids the kernel
// from declaring a class with a non-empty constructor, and an Error subclass is
// exactly that. Values also make failure paths type-checked rather than
// discovered, which is what lets a use case be exercised in memory.

import type { JsonValue } from "./domain-event.js";

/**
 * The closed set of failure kinds. Transports map these to their own status
 * spaces; the domain never names an HTTP status or an RPC code.
 */
export type ErrorCategory =
  | "invalid_input"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "precondition_failed"
  | "rate_limited"
  | "unavailable"
  | "internal";

export interface FieldViolation {
  /** Dotted path into the input — `credential.value`, `members[2].role`. */
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface DomainError {
  /** SCREAMING_SNAKE, stable within a major. Renaming one is a breaking change. */
  readonly code: string;
  readonly category: ErrorCategory;
  /**
   * Operator-facing text. It is rendered into logs and API responses, so it must
   * never carry a secret, a credential, or another tenant's data.
   */
  readonly message: string;
  readonly fields: readonly FieldViolation[];
  /** Populated only for `rate_limited` and `unavailable`. */
  readonly retryAfterSeconds: number | null;
  /** Structured, already-redacted context for logs. Never returned to a client. */
  readonly details: Readonly<Record<string, JsonValue>>;
}

export interface DomainErrorOptions {
  readonly fields?: readonly FieldViolation[];
  readonly retryAfterSeconds?: number;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

export function domainError(
  code: string,
  category: ErrorCategory,
  message: string,
  options: DomainErrorOptions = {},
): DomainError {
  if (!SCREAMING_SNAKE.test(code)) {
    throw new TypeError(`error code "${code}" must be SCREAMING_SNAKE_CASE (M0.4 §2)`);
  }
  return Object.freeze({
    code,
    category,
    message,
    fields: Object.freeze([...(options.fields ?? [])]),
    retryAfterSeconds: options.retryAfterSeconds ?? null,
    details: Object.freeze({ ...(options.details ?? {}) }),
  });
}

/**
 * The outcome of a use case.
 *
 * Ports and use cases return this rather than throwing, so every failure a
 * caller must handle is visible in the type. A thrown exception crossing a port
 * boundary means a defect, not a business outcome.
 */
export type Result<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: DomainError };

export function ok<Value>(value: Value): Result<Value> {
  return { ok: true, value };
}

export function err<Value = never>(error: DomainError): Result<Value> {
  return { ok: false, error };
}

export function isOk<Value>(result: Result<Value>): result is { readonly ok: true; readonly value: Value } {
  return result.ok;
}

/** Take the value, or throw. For tests and composition roots only. */
export function unwrap<Value>(result: Result<Value>): Value {
  if (result.ok) return result.value;
  throw new Error(`${result.error.code}: ${result.error.message}`);
}
