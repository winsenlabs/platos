// What went wrong out there, in this context's four outcome codes.
//
// THE RULE IS `channel-slack/src/failure.ts`'s, AND IT IS ASYMMETRIC ON PURPOSE:
// `CHANNELS_ADAPTER_UNAVAILABLE` (RETRY) only when the request PROVABLY did not
// take effect, and `CHANNELS_DELIVERY_INDETERMINATE` (RECONCILE) for everything
// that is neither that nor a definite refusal. A wrong guess in the first
// direction delays a message; in the second it posts a message twice into a
// customer's chat.
//
// WHERE TELEGRAM DIFFERS FROM THE OTHERS, AND WHAT FOLLOWS.
//
// THE ENVELOPE CARRIES THE VERDICT, AND THE ENVELOPE IS TRUSTED OVER THE STATUS.
// Every Bot API answer is `{ ok: true, result }` or `{ ok: false, error_code,
// description, parameters? }`, and `error_code` mirrors the HTTP status — usually.
// A proxy, a CDN error page or a gateway rewrite breaks that correspondence, and
// when the two disagree the BODY is the one Telegram wrote. So `error_code` is
// read first and the status is the fallback.
//
// `429` PUTS THE WAIT IN THE BODY, NOT IN A HEADER. `ResponseParameters.retry_after`
// is "the number of seconds left to wait before the request can be repeated". A
// client that looked only at `Retry-After` would find nothing and hammer the API —
// which is how a bot gets its webhook dropped.
//
// `403` IS NOT A DEAD CREDENTIAL, and this is the same departure `channel-discord`
// makes from `channel-slack`'s `no_permission -> UNAUTHORIZED`. Telegram answers
// 403 for "bot was blocked by the user" and "bot was kicked from the group chat"
// while the same token works everywhere else. Reporting it UNAUTHORIZED would
// send the refresh fence to re-authorize a bot that is perfectly alive, because
// one person blocked it. It is REJECTED: this message, to this chat, will not be
// accepted, and repeating it will not change that.
//
// `401` IS THE DEAD ONE. "Unauthorized" from the Bot API means the token itself
// is wrong or revoked, and nothing but a new token fixes it.
//
// A 5xx DEPENDS ON WHAT THE CALL WAS. A `500` on `sendMessage` may follow a
// message that was delivered, so a WRITE is INDETERMINATE. A `500` on `getMe`
// changed nothing anywhere, and the same holds for a timeout, a reset socket and
// an unreadable body: for a READ, "might have landed" has no meaning, and
// UNAVAILABLE is the honest code. The operation is passed IN, because only the
// caller knows whether it wrote.
//
// A RESET SOCKET IS NOT PROOF OF ANYTHING — the correction `channel-discord`
// makes to `channel-slack`'s list, carried here for the same reason. Only a
// connection that was never established (refused, unresolvable, unroutable) is
// UNAVAILABLE.

import {
  adapterRejected,
  adapterUnauthorized,
  adapterUnavailable,
  deliveryIndeterminate,
  type DomainError,
} from "@platos/context-channels/application/ports/index.js";

import { TELEGRAM_PROVIDER } from "./provider.js";

/** Whether a call can change state on the far side. See the header. */
export type TelegramOperation = "write" | "read";

/** The socket-level codes that PROVE no connection was ever established. */
const NEVER_CONNECTED: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function causeCode(error: unknown): string | null {
  let current: unknown = error;
  // `TypeError: fetch failed` -> `cause: Error { code }`, sometimes one deeper.
  for (let hop = 0; hop < 3 && current !== null && typeof current === "object"; hop += 1) {
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { readonly cause?: unknown }).cause ?? null;
  }
  return null;
}

/**
 * The code an operator looks up, and NEVER the `description`.
 *
 * Telegram's `description` is English prose that echoes request content back —
 * "chat not found", but also "message text is empty" and, for `getChat`, the
 * chat's own title. It is not carried into a `DomainError` that will be logged.
 */
export function describeStatus(status: number, errorCode: number | null): string {
  return errorCode === null || errorCode === status
    ? `http ${status}`
    : `http ${status} error_code ${errorCode}`;
}

/** Classify a response that ARRIVED and was not a success. */
export function classifyTelegramStatus(
  status: number,
  errorCode: number | null,
  operation: TelegramOperation,
  retryAfterSeconds: number,
): DomainError {
  const reason = describeStatus(status, errorCode);
  // THE BODY'S VERDICT BEFORE THE STATUS. See the header.
  const verdict = errorCode ?? status;
  if (verdict === 429) return adapterUnavailable(TELEGRAM_PROVIDER, reason, retryAfterSeconds);
  if (verdict === 401) return adapterUnauthorized(TELEGRAM_PROVIDER, reason);
  if (verdict >= 500) {
    return operation === "write"
      ? deliveryIndeterminate(TELEGRAM_PROVIDER, reason)
      : adapterUnavailable(TELEGRAM_PROVIDER, reason);
  }
  return adapterRejected(TELEGRAM_PROVIDER, reason);
}

/**
 * A success status whose body is not the JSON envelope Telegram answers with — a
 * proxy's page, a truncated stream. For a write the request left and what came
 * back says nothing about it; for a read nothing changed.
 */
export function classifyUnreadableAnswer(status: number, operation: TelegramOperation): DomainError {
  const reason = `http ${status} with an unreadable body`;
  return operation === "write"
    ? deliveryIndeterminate(TELEGRAM_PROVIDER, reason)
    : adapterUnavailable(TELEGRAM_PROVIDER, reason);
}

/**
 * Classify a thrown value from a call.
 *
 * `timedOut` is passed IN because only the owner of the deadline knows whether it
 * fired; an `AbortError` alone could be a caller's own signal.
 */
export function classifyTelegramThrow(
  error: unknown,
  timedOut: boolean,
  operation: TelegramOperation,
): DomainError {
  const code = causeCode(error);
  if (!timedOut && code !== null && NEVER_CONNECTED.has(code)) {
    return adapterUnavailable(TELEGRAM_PROVIDER, code);
  }
  const reason = timedOut ? "deadline elapsed with no response" : (code ?? "unclassified transport failure");
  return operation === "write"
    ? deliveryIndeterminate(TELEGRAM_PROVIDER, reason)
    : adapterUnavailable(TELEGRAM_PROVIDER, reason);
}
