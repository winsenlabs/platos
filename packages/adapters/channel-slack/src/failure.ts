// What went wrong out there, in this context's four outcome codes.
//
// THE HARD DISTINCTION IS BETWEEN "DID NOT LAND" AND "DO NOT KNOW", and it is
// the reason this file exists rather than a two-line `catch`. `channels`'
// `domain/delivery.ts` turns the code into a disposition: `UNAVAILABLE` is
// RETRY, `INDETERMINATE` is RECONCILE. Get the classification wrong in the safe
// direction and a message is delayed; get it wrong in the other and a message is
// posted twice into a customer's channel. So the rule here is asymmetric on
// purpose: a failure is `UNAVAILABLE` only when the request PROVABLY never
// reached the far side, and everything else that is not a definite refusal is
// `INDETERMINATE`.
//
// WHAT COUNTS AS PROOF THAT NOTHING LANDED. Exactly one thing: the connection
// was never established. `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN` and
// `ECONNRESET`-before-headers all mean no request bytes were accepted, and Node
// surfaces them as a `TypeError` whose `cause` carries the code. A TIMEOUT is
// NOT proof of anything: the request may be sitting in the far side's accept
// queue, may have been fully processed, may have posted the message and lost
// only the response. That is exactly `INDETERMINATE`.
//
// SLACK ANSWERS 200 FOR ITS OWN FAILURES, which is why the status is not the
// classifier. `{"ok": false, "error": "channel_not_found"}` arrives with HTTP
// 200, so the `error` STRING is what separates a dead credential from a bad
// message, and the two lists below are what this adapter is willing to say it
// understands. An error string on NEITHER list is `REJECTED` and not
// `UNAVAILABLE`: the far side answered, deliberately, with a refusal it named —
// retrying sends the same message to the same refusal.

import {
  adapterRejected,
  adapterUnauthorized,
  adapterUnavailable,
  deliveryIndeterminate,
  type DomainError,
} from "@platos/context-channels/application/ports/index.js";

import { SLACK_PROVIDER } from "./provider.js";
import { SlackApiError } from "./vendor.js";

/**
 * The `error` strings that mean THE CREDENTIAL IS DEAD.
 *
 * Every one is terminal for this token: refreshing or re-authorizing is the
 * remedy and retrying presents the same dead token. Taken from the vendor's
 * published error vocabulary rather than invented, and kept short — an
 * unrecognised string falls through to `REJECTED`, which wastes nothing, where
 * a guess in this direction would suppress a real message failure as an auth
 * problem.
 */
const CREDENTIAL_ERRORS: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "no_permission",
  "missing_scope",
]);

/** The `error` strings that mean THE PROVIDER IS HAVING A BAD DAY. */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  "ratelimited",
  "rate_limited",
  "service_unavailable",
  "internal_error",
  "fatal_error",
  "request_timeout",
]);

/** The socket-level codes that PROVE no request reached the far side. */
const NEVER_CONNECTED: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "UND_ERR_SOCKET",
]);

function causeCode(error: unknown): string | null {
  let current: unknown = error;
  // Node nests: `TypeError: fetch failed` -> `cause: Error { code }`, and undici
  // sometimes nests one deeper again. Three hops is enough for every shape seen
  // and terminates on anything.
  for (let hop = 0; hop < 3 && current !== null && typeof current === "object"; hop += 1) {
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { readonly cause?: unknown }).cause ?? null;
  }
  return null;
}

/** True for the abort this adapter itself raises when its deadline elapses. */
export function isDeadlineAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { readonly name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError" || causeCode(error) === "UND_ERR_ABORTED";
}

/**
 * Classify one thrown value from an outbound call.
 *
 * `timedOut` is passed IN rather than sniffed out of the error, because the two
 * are genuinely different questions and only the caller knows the answer to the
 * first: an `AbortError` can also come from a caller's own signal, and undici
 * reports a deadline in more than one shape depending on how far the request
 * had got. The caller owns the deadline, so the caller says whether it fired.
 */
export function classifySlackFailure(error: unknown, timedOut: boolean): DomainError {
  if (timedOut || isDeadlineAbort(error)) {
    return deliveryIndeterminate(SLACK_PROVIDER, "deadline elapsed with no response");
  }

  if (error instanceof SlackApiError) {
    const answered = typeof error.response?.error === "string" ? error.response.error : "";
    if (CREDENTIAL_ERRORS.has(answered)) return adapterUnauthorized(SLACK_PROVIDER, answered);
    if (TRANSIENT_ERRORS.has(answered)) return adapterUnavailable(SLACK_PROVIDER, answered);
    // A 5xx or a 429 with no parseable body: the far side answered, and it
    // answered that it could not serve this now. Retrying is the remedy.
    const status = error.status ?? 0;
    if (answered === "" && (status === 429 || status >= 500)) {
      return adapterUnavailable(SLACK_PROVIDER, `http ${status}`);
    }
    return adapterRejected(SLACK_PROVIDER, answered === "" ? `http ${status}` : answered);
  }

  const code = causeCode(error);
  if (code !== null && NEVER_CONNECTED.has(code)) {
    return adapterUnavailable(SLACK_PROVIDER, code);
  }

  // Something threw that is neither the vendor's refusal nor a socket this
  // adapter recognises. The commonest real instance is a `SyntaxError` from the
  // SDK parsing a non-JSON error page — a proxy's 502, a captive portal, a load
  // balancer's plain-text 503 — where the request definitely LEFT and what came
  // back says nothing about whether the message was posted.
  //
  // It is NOT retried on that basis: an unrecognised throw from a code path that
  // had already dispatched a request is exactly the state `INDETERMINATE` names,
  // and defaulting the unknown to RETRY is how the one mistake that duplicates a
  // customer-visible message gets made.
  return deliveryIndeterminate(SLACK_PROVIDER, code ?? "unclassified transport failure");
}
