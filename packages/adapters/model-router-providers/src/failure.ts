// Turning what the framework threw into what the port promised.
//
// The `ModelRouter` port's third property is that failure is a VALUE: every
// method returns `Result<T>`, and an implementation must translate its client's
// errors into `PROVIDERS_*` domain errors and must not let a vendor error
// escape. A caller banned from importing the SDK (ADR M0.3 §2) cannot catch a
// typed error from it, so an escaping one is not a business outcome — it is an
// unhandled rejection in whatever context happened to call.
//
// WHAT IS DISTINGUISHED, AND WHY EACH SEPARATION EARNS ITS CODE.
//
//   abort           the caller hung up. Nothing is wrong upstream and a retry is
//                   pointless, so it must not read as an outage.
//   auth refusal    the provider judged the credential. Only this condemns a
//                   key; everything else says nothing about it, and collapsing
//                   the two sends an operator to rotate a good key because a
//                   provider had a bad hour.
//   everything else `provider_request_failed`, with the diagnosis in `details`,
//                   which the kernel documents as never reaching a client.

import {
  err,
  generationAborted,
  providerRequestFailed,
  type DomainError,
  type FinishReason,
  type Result,
} from "@platos/context-providers/application/ports/index.js";
import { APICallError } from "ai";

/** The statuses that mean the provider judged the credential and refused it. */
export const AUTH_REFUSAL_STATUSES = Object.freeze([401, 403]);

/**
 * Did the caller abandon this?
 *
 * Checked structurally rather than by class, because an abort arrives from three
 * different layers — the runtime's own `AbortError`, a `DOMException` named
 * `AbortError`, and a signal-carrying error the framework re-wraps — and a class
 * check would catch one of the three and report the other two as outages.
 */
export function isAbort(thrown: unknown, signal: AbortSignal | null): boolean {
  if (signal !== null && signal.aborted) return true;
  if (typeof thrown !== "object" || thrown === null) return false;
  const named = thrown as { name?: unknown; code?: unknown };
  return named.name === "AbortError" || named.code === "ABORT_ERR";
}

/** Did the provider itself refuse the credential? */
export function isAuthRefusal(thrown: unknown): boolean {
  if (!APICallError.isInstance(thrown)) return false;
  return thrown.statusCode !== undefined && AUTH_REFUSAL_STATUSES.includes(thrown.statusCode);
}

/**
 * A short, safe description of what went wrong.
 *
 * It lands in `details.reason`, never in `message`: the runtime message a client
 * sees is one fixed sentence per code, and the diagnosis stays server-side. A
 * provider's response body is deliberately NOT included — it is the one field
 * that has been observed to echo a request, and a request carries a prompt.
 */
export function describe(thrown: unknown): string {
  if (APICallError.isInstance(thrown)) {
    const status = thrown.statusCode ?? "no status";
    return `${thrown.name}: ${status}`;
  }
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`;
  return "the provider client failed without an error value";
}

/**
 * The single translation point.
 *
 * Everything that can throw inside this package goes through here, so there is
 * exactly one place where a vendor error stops being one.
 */
export function translate(thrown: unknown, signal: AbortSignal | null): DomainError {
  if (isAbort(thrown, signal)) return generationAborted(describe(thrown));
  return providerRequestFailed(describe(thrown));
}

export function failed<T>(thrown: unknown, signal: AbortSignal | null): Result<T> {
  return err(translate(thrown, signal));
}

/**
 * The framework's finish reason, in this system's vocabulary.
 *
 * The two vocabularies agree on five of six names. `aborted` exists only on
 * this side — the framework reports an abandoned generation through its stream
 * rather than as a finish reason — so it is never produced here and is set by
 * the caller that saw the abort.
 */
export function toFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "stop":
    case "length":
    case "tool-calls":
    case "content-filter":
    case "error":
      return reason;
    default:
      return "other";
  }
}
