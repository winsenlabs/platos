// What went wrong out there, in this context's four outcome codes.
//
// THE RULE IS `channel-slack/src/failure.ts`'s, AND IT IS ASYMMETRIC ON PURPOSE:
// `CHANNELS_ADAPTER_UNAVAILABLE` (RETRY) only when the request PROVABLY did not
// take effect, and `CHANNELS_DELIVERY_INDETERMINATE` (RECONCILE) for everything
// that is neither that nor a definite refusal. A wrong guess in the first
// direction delays a message; in the second it sends a message twice to a
// customer's phone — and WhatsApp has no edit, so a duplicate there is permanent.
//
// WHERE META DIFFERS FROM DISCORD, AND WHAT FOLLOWS.
//
// THE STATUS IS NOT ENOUGH, AND `190` IS THE CASE THAT PROVES IT. Graph answers
// an expired, revoked or malformed access token with **HTTP 400** and
// `error.code = 190` — not 401. A classifier that read only the status would
// report a DEAD CREDENTIAL as a rejected message: the refresh fence would never
// fire, and every send on that connection would fail forever with nothing asking
// for a new token. So the numeric code is consulted BEFORE the status, and
// `vendor.ts` transcribes the four codes that are acted on.
//
// THE RATE-LIMIT CODES ARE A FAMILY, NOT A STATUS. Meta signals throughput
// refusals as `130429`, `131056`, `80007` and `4`, and it does not answer all of
// them with 429. They mean one thing to a caller — the request was NOT processed,
// wait and resend — so they map to UNAVAILABLE, which is the one code that says
// "nothing landed" without qualification.
//
// AND META PUBLISHES NO WAIT. Discord documents `Retry-After` and
// `X-RateLimit-Reset-After` and this adapter obeys them; the Cloud API documents
// neither. `Retry-After` is read when a proxy in front of Graph supplies one, and
// with nothing at all the wait is `DEFAULT_RATE_LIMIT_WAIT_SECONDS` below — a
// number THIS ADAPTER CHOSE, stated as such rather than dressed up as Meta's.
//
// A 5xx DEPENDS ON WHAT THE CALL WAS. A `500` on `POST <phone>/messages` may
// follow a message that was sent — the far side answered that it failed, not that
// it did nothing — so a WRITE is INDETERMINATE. A `500` on `GET <phone>` changed
// nothing anywhere, and the same holds for a timeout, a reset socket and an
// unreadable body: for a READ, "might have landed" has no meaning, and UNAVAILABLE
// is the honest code. The operation is passed IN, because only the caller knows
// whether it wrote.
//
// A RESET SOCKET IS NOT PROOF OF ANYTHING — the correction `channel-discord`
// makes to `channel-slack`'s list, carried here for the same reason.
// `ECONNRESET` after the server has read the whole request says nothing about
// whether the message went out, and the socket error does not say which side of
// that line it fell on. Only a connection that was never established (refused,
// unresolvable, unroutable) is UNAVAILABLE.

import {
  adapterRejected,
  adapterUnauthorized,
  adapterUnavailable,
  deliveryIndeterminate,
  type DomainError,
} from "@platos/context-channels/application/ports/index.js";

import { WHATSAPP_PROVIDER } from "./provider.js";
import { WHATSAPP_ERROR_CODE, WHATSAPP_RATE_LIMIT_CODES } from "./vendor.js";

/** Whether a call can change state on the far side. See the header. */
export type WhatsAppOperation = "write" | "read";

/**
 * How long to wait after a rate-limit refusal that named no wait at all.
 *
 * SIXTY SECONDS, AND IT IS THIS ADAPTER'S NUMBER. The Cloud API's throughput
 * limits are per-second and per-24-hour, and Meta publishes no hint on the
 * refusal; a shorter wait walks straight back into the same limit and every
 * refused call counts against the app's error budget, and a much longer one
 * would hold an inbox lease for no reason. It is a constant rather than a
 * configuration field because an operator has nothing to base a better value on
 * either.
 */
export const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 60;

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
 * Meta's JSON error body carries a numeric `error.code` (`190`, `131056`, ...).
 * It is kept in the reason because it is what an operator searches the Cloud API
 * error reference for; the message text is not, because it is English, changes,
 * and has been observed to echo request content back.
 */
export function describeStatus(status: number, metaCode: number | null): string {
  return metaCode === null ? `http ${status}` : `http ${status} code ${metaCode}`;
}

/** Classify a response that ARRIVED and was not a success. */
export function classifyWhatsAppStatus(
  status: number,
  metaCode: number | null,
  operation: WhatsAppOperation,
  retryAfterSeconds: number,
): DomainError {
  const reason = describeStatus(status, metaCode);
  // THE CODE BEFORE THE STATUS. See the header: `190` arrives as a 400.
  if (metaCode !== null && WHATSAPP_RATE_LIMIT_CODES.has(metaCode)) {
    return adapterUnavailable(WHATSAPP_PROVIDER, reason, retryAfterSeconds);
  }
  if (metaCode === WHATSAPP_ERROR_CODE.accessToken) {
    return adapterUnauthorized(WHATSAPP_PROVIDER, reason);
  }
  if (status === 429) return adapterUnavailable(WHATSAPP_PROVIDER, reason, retryAfterSeconds);
  if (status === 401) return adapterUnauthorized(WHATSAPP_PROVIDER, reason);
  if (status >= 500) {
    return operation === "write"
      ? deliveryIndeterminate(WHATSAPP_PROVIDER, reason)
      : adapterUnavailable(WHATSAPP_PROVIDER, reason);
  }
  // Every other 4xx: this message, to this recipient, will not be accepted, and
  // repeating it will not change that — a closed 24-hour window (131047), an
  // undeliverable number (131026), a template mismatch. REJECTED and not
  // UNAUTHORIZED, because the credential is fine.
  return adapterRejected(WHATSAPP_PROVIDER, reason);
}

/**
 * A success status whose body is not the JSON Graph answers with — a proxy's
 * page, a truncated stream. For a write the request left and what came back says
 * nothing about it; for a read nothing changed.
 */
export function classifyUnreadableAnswer(status: number, operation: WhatsAppOperation): DomainError {
  const reason = `http ${status} with an unreadable body`;
  return operation === "write"
    ? deliveryIndeterminate(WHATSAPP_PROVIDER, reason)
    : adapterUnavailable(WHATSAPP_PROVIDER, reason);
}

/**
 * Classify a thrown value from a call.
 *
 * `timedOut` is passed IN because only the owner of the deadline knows whether it
 * fired; an `AbortError` alone could be a caller's own signal.
 */
export function classifyWhatsAppThrow(
  error: unknown,
  timedOut: boolean,
  operation: WhatsAppOperation,
): DomainError {
  const code = causeCode(error);
  if (!timedOut && code !== null && NEVER_CONNECTED.has(code)) {
    return adapterUnavailable(WHATSAPP_PROVIDER, code);
  }
  const reason = timedOut ? "deadline elapsed with no response" : (code ?? "unclassified transport failure");
  return operation === "write"
    ? deliveryIndeterminate(WHATSAPP_PROVIDER, reason)
    : adapterUnavailable(WHATSAPP_PROVIDER, reason);
}
