// What went wrong out there, in this context's four outcome codes.
//
// THE RULE IS `channel-slack/src/failure.ts`'s, AND IT IS ASYMMETRIC ON PURPOSE:
// `CHANNELS_ADAPTER_UNAVAILABLE` (RETRY) only when the request PROVABLY did not
// take effect, and `CHANNELS_DELIVERY_INDETERMINATE` (RECONCILE) for everything
// that is neither that nor a definite refusal. A wrong guess in the first
// direction delays a message; in the second it posts a message twice into a
// customer's channel.
//
// WHERE DISCORD DIFFERS FROM SLACK, AND WHAT FOLLOWS.
//
// DISCORD ANSWERS ITS FAILURES WITH HTTP STATUSES, so the status is the
// classifier — unlike Slack, which answers `200 {ok:false}`. `401` is a dead
// token (UNAUTHORIZED). `429` is a request Discord REFUSED to process
// (`developers/topics/rate-limits.mdx`: the limit was "exceeded" and the request
// is to be resubmitted after `retry_after`), so it is the one status that proves
// nothing landed: UNAVAILABLE, with the wait Discord asked for.
//
// `403` IS NOT A DEAD CREDENTIAL, and this is a deliberate departure from Slack's
// `no_permission -> UNAUTHORIZED`. Discord returns 403 for "Missing Access"
// (50001) and "Missing Permissions" (50013) on ONE channel while the same token
// posts everywhere else. Reporting it UNAUTHORIZED would send the refresh fence
// to re-authorize an installation that is fine. It is REJECTED: this message, to
// this channel, will not be accepted, and repeating it will not change that. The
// other 4xx are REJECTED for the same reason.
//
// A 5xx DEPENDS ON WHAT THE CALL WAS. A `500` on `POST channels/{id}/messages`
// may follow a message that was created — the far side answered that it failed,
// not that it did nothing — so a WRITE is INDETERMINATE. A `500` on
// `GET users/@me` changed nothing anywhere, and the same holds for a timeout, a
// reset socket and an unreadable body: for a READ, "might have landed" has no
// meaning, and UNAVAILABLE is the honest code. The operation is passed IN, because
// only the caller knows whether it wrote.
//
// A RESET SOCKET IS NOT PROOF OF ANYTHING. `channel-slack` lists `ECONNRESET` and
// `UND_ERR_SOCKET` among the codes that prove "no request bytes were accepted".
// That holds for a reset during the connect and not for one after the server has
// read the whole request, and the socket error does not say which.
// `discord-transport.test.ts` reproduces the second — the far side reads the
// request, records it, and destroys the connection — and requires INDETERMINATE,
// with the far side's record showing the message it received. Only a connection
// that was never established (refused, unresolvable, unroutable) is UNAVAILABLE
// here.

import {
  adapterRejected,
  adapterUnauthorized,
  adapterUnavailable,
  deliveryIndeterminate,
  type DomainError,
} from "@platos/context-channels/application/ports/index.js";

import { DISCORD_PROVIDER } from "./provider.js";

/** Whether a call can change state on the far side. See the header. */
export type DiscordOperation = "write" | "read";

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
 * Discord's JSON error body carries a numeric `code` (`50013`, `10003`, ...).
 * It is kept in the reason because it is what an operator searches the API
 * reference for; the message text is not, because it is English and changes.
 */
export function describeStatus(status: number, discordCode: number | null): string {
  return discordCode === null ? `http ${status}` : `http ${status} code ${discordCode}`;
}

/** Classify a response that ARRIVED and was not a success. */
export function classifyDiscordStatus(
  status: number,
  discordCode: number | null,
  operation: DiscordOperation,
  retryAfterSeconds: number,
): DomainError {
  const reason = describeStatus(status, discordCode);
  if (status === 429) return adapterUnavailable(DISCORD_PROVIDER, reason, retryAfterSeconds);
  if (status === 401) return adapterUnauthorized(DISCORD_PROVIDER, reason);
  if (status >= 500) {
    return operation === "write"
      ? deliveryIndeterminate(DISCORD_PROVIDER, reason)
      : adapterUnavailable(DISCORD_PROVIDER, reason);
  }
  return adapterRejected(DISCORD_PROVIDER, reason);
}

/**
 * A success status whose body is not the JSON Discord answers with — a proxy's
 * page, a truncated stream. For a write the request left and what came back says
 * nothing about it; for a read nothing changed.
 */
export function classifyUnreadableAnswer(status: number, operation: DiscordOperation): DomainError {
  const reason = `http ${status} with an unreadable body`;
  return operation === "write"
    ? deliveryIndeterminate(DISCORD_PROVIDER, reason)
    : adapterUnavailable(DISCORD_PROVIDER, reason);
}

/**
 * Classify a thrown value from a call.
 *
 * `timedOut` is passed IN because only the owner of the deadline knows whether it
 * fired; an `AbortError` alone could be a caller's own signal.
 */
export function classifyDiscordThrow(error: unknown, timedOut: boolean, operation: DiscordOperation): DomainError {
  const code = causeCode(error);
  if (!timedOut && code !== null && NEVER_CONNECTED.has(code)) {
    return adapterUnavailable(DISCORD_PROVIDER, code);
  }
  const reason = timedOut ? "deadline elapsed with no response" : (code ?? "unclassified transport failure");
  return operation === "write"
    ? deliveryIndeterminate(DISCORD_PROVIDER, reason)
    : adapterUnavailable(DISCORD_PROVIDER, reason);
}
