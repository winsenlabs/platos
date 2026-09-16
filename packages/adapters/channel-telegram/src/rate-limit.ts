// What Telegram has REFUSED, remembered, so the next call on a limited chat is
// refused HERE rather than by the Bot API.
//
// THE MODEL IS THE POOR ONE, LIKE `channel-whatsapp`'s AND FOR THE SAME REASON:
// the vendor publishes nothing on a success. Discord sends
// `X-RateLimit-Remaining` on ordinary answers so a client can stop BEFORE it is
// refused; Telegram sends nothing until it says 429, and then says
// `parameters.retry_after` in the body. So this table learns from failures only,
// and it does not pretend to model limits Telegram has documented in prose
// ("roughly one message per second to a chat, 30 messages per second overall")
// but does not report on the wire. A counter built on those numbers would be this
// repository's guess wearing Telegram's name.
//
// WHY REFUSING LOCALLY IS WORTH ANYTHING AT ALL. Telegram's documented remedy for
// a 429 is to WAIT `retry_after` seconds; a client that retries sooner is
// answered 429 again with a LONGER wait, and sustained abuse gets the webhook
// dropped. After a refusal the scope is held, and the next call inside it is
// answered `CHANNELS_ADAPTER_UNAVAILABLE` with `retryAfterSeconds` and NO SOCKET
// IS OPENED — the one outcome `UNAVAILABLE` names without qualification, because
// the request never left. Sleeping inside `send` instead would spend an inbox
// lease on a timer and hide the wait from the only layer that can reschedule
// work.
//
// TWO SCOPES, BECAUSE TELEGRAM HAS TWO LIMITS AND ONE 429. A 429 naming a chat is
// held on that chat; a 429 on a call with no chat (`getMe`) is held on the bot.
// Telegram does not say which of its two limits it hit, so the scope is the
// narrowest one the CALL can name, and a bot-wide limit therefore surfaces as a
// sequence of per-chat holds rather than as one. That is an under-approximation,
// it is stated as one, and it errs toward sending rather than toward silence —
// which for a bot that has already been refused once is the lesser of two
// mistakes only because the refusal itself is cheap and idempotent.
//
// THE CREDENTIAL IS A DIGEST AND NEVER THE TOKEN. Two bots in one process must
// not throttle each other, and the key that separates them must not be the bot
// token itself sitting in a `Map` for the process's lifetime.

import { createHash } from "node:crypto";

/** One request's place in Telegram's throughput model. */
export interface TelegramRoute {
  /** A digest of the bot token the call is made with. Never the token itself. */
  readonly identity: string;
  /** The chat the call addresses, or null for a call that names none. */
  readonly chatId: string | null;
}

export type TelegramAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly retryAfterSeconds: number; readonly reason: string };

/** A short, stable, non-reversible handle for a credential. */
export function credentialIdentity(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 32);
}

/** Whole seconds, at least one. A wait of zero invites a hot loop. */
export function wholeSeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

/**
 * The size at which a sweep runs. NOT a bound on the table.
 *
 * STATED THE WAY `channel-discord/src/rate-limit.ts` states its own, because the
 * same thing is true here: `prune` returns below this figure and above it deletes
 * only what has EXPIRED, so when every remembered window is still live it deletes
 * nothing. THE REAL BOUND IS THE NUMBER OF LIVE WINDOWS, and it is left that way
 * deliberately — a live window is a limit Telegram is currently imposing, and
 * forgetting one to cap memory would send a call the far side has already refused.
 * The worst case is one entry per chat currently being throttled.
 */
export const MAX_REMEMBERED_WINDOWS = 1024;

export class TelegramRateLimits {
  private readonly heldUntil = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  /** Entries held. Bounded by the LIVE windows, not by the constant above. */
  get size(): number {
    return this.heldUntil.size;
  }

  admit(route: TelegramRoute): TelegramAdmission {
    const at = this.now();
    const until = this.heldUntil.get(this.key(route)) ?? 0;
    if (until > at) {
      return { admitted: false, retryAfterSeconds: wholeSeconds(until - at), reason: "rate limited" };
    }
    return { admitted: true };
  }

  /**
   * Hold this route for `waitSeconds` after a refusal.
   *
   * The LATER instant wins: a second refusal that asks for less must not shorten
   * a wait the far side already imposed.
   */
  hold(route: TelegramRoute, waitSeconds: number): void {
    const at = this.now();
    this.prune(at);
    const key = this.key(route);
    const until = at + Math.max(1, waitSeconds) * 1000;
    this.heldUntil.set(key, Math.max(this.heldUntil.get(key) ?? 0, until));
  }

  /**
   * Forget what no longer holds anything back, once the table is large.
   *
   * A window that has passed carries no information: `admit` already treats it as
   * absent, so dropping it changes no answer this object gives.
   */
  private prune(at: number): void {
    if (this.heldUntil.size < MAX_REMEMBERED_WINDOWS) return;
    for (const [key, until] of this.heldUntil) if (until <= at) this.heldUntil.delete(key);
  }

  private key(route: TelegramRoute): string {
    return route.chatId === null ? `bot ${route.identity}` : `chat ${route.identity} ${route.chatId}`;
  }
}
