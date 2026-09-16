// What Meta has REFUSED, remembered, so the next call on a limited line is
// refused HERE rather than by Graph.
//
// THE MODEL IS DELIBERATELY POORER THAN `channel-discord`'s, AND THE REASON IS
// THE VENDOR. Discord publishes `X-RateLimit-Bucket`, `-Remaining` and
// `-Reset-After` on ORDINARY answers, so a well-behaved client can stop BEFORE it
// is refused. The Cloud API publishes none of that: throughput limits are
// documented as per-second and per-24-hour figures and the only signal on the
// wire is the refusal itself. So there is nothing to learn from a success, and
// this table learns from failures only. Writing a bucket model over headers Meta
// does not send would be a model of a fiction.
//
// WHAT IT DOES DO, AND WHY IT IS WORTH HAVING. Meta counts REFUSED calls against
// an app's error rate, and a sustained error rate gets an app restricted. So a
// caller that retries into a live refusal is not merely wasting a send; it is
// spending the app's standing. After a refusal the scope is held for the wait,
// and the next call inside it is answered `CHANNELS_ADAPTER_UNAVAILABLE` with
// `retryAfterSeconds` and NO SOCKET IS OPENED. That refusal is the one outcome
// `UNAVAILABLE` names without qualification — the request provably did not land,
// because it never left — so the port's retry rule sends it to RETRY and the
// caller schedules it. Sleeping inside `send` instead would spend an inbox lease
// on a timer and hide the wait from the only layer that can reschedule work.
//
// THREE SCOPES, BECAUSE META DOCUMENTS THREE LIMITS AND THEY ARE NOT NESTED BY
// ACCIDENT:
//
//   pair        `131056` — too many messages to ONE customer from ONE line. It
//               must not silence the rest of the line, which is the whole reason
//               this scope exists separately.
//   line        `130429` — the Cloud API throughput limit for ONE business phone
//               number. Holds every conversation on that line and no other line.
//   credential  `80007` (the business account's own limit), `4` (the app's Graph
//               call volume) and a bare HTTP 429 with no code. These are limits on
//               the ACCOUNT or the APP, so they hold every line this token serves.
//
// The scope is decided by the classifier from Meta's own numeric code and passed
// in; it is never guessed here. A bare 429 falls to the widest scope on purpose:
// an unattributed refusal is the one case where holding too much is safer than
// holding too little.
//
// THE CREDENTIAL IS A DIGEST AND NEVER THE TOKEN. Two business accounts served by
// one process must not throttle each other, and the key that separates them must
// not be the access token itself sitting in a `Map` for the process's lifetime.

import { createHash } from "node:crypto";

/** One request's place in Meta's throughput model. */
export interface WhatsAppRoute {
  /** A digest of the credential the call is made with. Never the token itself. */
  readonly identity: string;
  /** The business phone number id the call is made on. */
  readonly phoneNumberId: string;
  /** The recipient, for a pair-scoped limit. Null for a call with no recipient. */
  readonly recipient: string | null;
}

/** Which scope a refusal holds back. See the header. */
export const WHATSAPP_LIMIT_SCOPES = Object.freeze(["pair", "line", "credential"] as const);

export type WhatsAppLimitScope = (typeof WHATSAPP_LIMIT_SCOPES)[number];

export type WhatsAppAdmission =
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
 * MEASURED AND STATED THE WAY `channel-discord/src/rate-limit.ts` states its own,
 * because the same thing is true here: `prune` returns below this figure and
 * above it deletes only what has EXPIRED, so when every remembered window is
 * still live it deletes nothing and the table keeps growing. THE REAL BOUND IS
 * THE NUMBER OF LIVE WINDOWS, and it is left that way deliberately — a live
 * window is a limit Meta is currently imposing, and forgetting one to cap memory
 * would send a call the far side has already refused. The worst case is one entry
 * per customer currently being throttled on a line, which is the number of
 * customers a rate-limited line is mid-conversation with.
 */
export const MAX_REMEMBERED_WINDOWS = 1024;

export class WhatsAppRateLimits {
  private readonly heldUntil = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  /** Entries held. Bounded by the LIVE windows, not by the constant above. */
  get size(): number {
    return this.heldUntil.size;
  }

  /**
   * WIDEST SCOPE FIRST. A credential held by an account-wide refusal must not be
   * admitted merely because this particular line has no window of its own.
   */
  admit(route: WhatsAppRoute): WhatsAppAdmission {
    const at = this.now();
    for (const scope of WHATSAPP_LIMIT_SCOPES.slice().reverse()) {
      const until = this.heldUntil.get(this.key(route, scope)) ?? 0;
      if (until > at) {
        return { admitted: false, retryAfterSeconds: wholeSeconds(until - at), reason: `${scope} rate limited` };
      }
    }
    return { admitted: true };
  }

  /**
   * Hold a scope for `waitSeconds` after a refusal.
   *
   * The LATER instant wins: a second refusal that asks for less must not shorten
   * a wait the far side already imposed.
   */
  hold(route: WhatsAppRoute, scope: WhatsAppLimitScope, waitSeconds: number): void {
    const at = this.now();
    this.prune(at);
    const key = this.key(route, scope);
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

  /**
   * A pair key falls back to the LINE key when the call named no recipient, so a
   * pair-scoped refusal on a call with nobody to name cannot silently create a
   * window nothing will ever look up.
   */
  private key(route: WhatsAppRoute, scope: WhatsAppLimitScope): string {
    if (scope === "credential") return `credential ${route.identity}`;
    if (scope === "line" || route.recipient === null) return `line ${route.identity} ${route.phoneNumberId}`;
    return `pair ${route.identity} ${route.phoneNumberId} ${route.recipient}`;
  }
}
