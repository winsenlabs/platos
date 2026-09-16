// What Discord has said about its rate limits, remembered, so the next request on
// an exhausted bucket is refused HERE rather than by Discord.
//
// `developers/topics/rate-limits.mdx` is unusually direct about what a client
// owes: "429 responses are avoided by inspecting the rate limit headers ... and by
// not making requests on exhausted buckets until after they have reset", and an IP
// that makes 10,000 invalid requests — 401, 403 or 429 — in ten minutes is
// temporarily banned from the whole API. So a 429 is not only a failed send; it
// is a step towards every bot on the host going dark. Retrying on a 429 without
// reading the headers is how a busy afternoon becomes a Cloudflare ban.
//
// WHAT THIS DOES WITH THAT, AND WHY IT REFUSES RATHER THAN WAITS. Before a
// request, the route's last known bucket is consulted; if it has no requests left
// and has not reset, the call is refused with `CHANNELS_ADAPTER_UNAVAILABLE` and
// `retryAfterSeconds`, and NO SOCKET IS OPENED. That refusal is the one outcome
// `UNAVAILABLE` names without qualification — the request provably did not land,
// because it never left — so the port's retry rule sends it to RETRY and the
// caller schedules it. Sleeping inside `send` instead would spend an inbox lease
// on a timer and hide the wait from the only layer that can reschedule work.
//
// THE BUCKET MODEL, as the document gives it. Limits are per route; routes that
// share a limit share an `X-RateLimit-Bucket` value; and a bucket is further split
// by the route's TOP-LEVEL RESOURCE — "channels (`channel_id`), guilds
// (`guild_id`), and webhooks (`webhook_id` or `webhook_id + webhook_token`)" — so
// exhausting `/channels/1234` leaves `/channels/9876` free. The state is keyed on
// (credential, bucket, top-level resource), with the route remembered only as the
// way to find its bucket. The credential half is not in the document and does not
// need to be: limits "are applied to individual bots", so two bot tokens in one
// process must never throttle each other. It is a digest, never the token.
//
// THE GLOBAL LIMIT, AND THE ROUTES IT DOES NOT BIND. A 429 with
// `X-RateLimit-Global: true` stops every route for that credential until it
// clears. Interaction followups are exempt — "Interaction endpoints are not bound
// to the bot's Global Rate Limit" — and they are exempt BY CONSTRUCTION rather
// than by a flag: a followup presents no bot token, so its identity is a digest of
// the interaction token, and no bot's global block is ever looked up for it. (An
// earlier draft carried a `globalBound` flag as well; the mutation sweep showed no
// case could tell it apart from its negation, because the identity already
// separates the two, so the flag was dead and is gone.)

import { createHash } from "node:crypto";

import { DISCORD_RATE_LIMIT_HEADER } from "./vendor.js";

/** One request's place in Discord's rate-limit model. */
export interface RateLimitRoute {
  /** A digest of the credential the call is made with. Never the token itself. */
  readonly identity: string;
  /** The route with its ids replaced, e.g. `POST channels/{channel}/messages`. */
  readonly template: string;
  /** The top-level resource id the bucket is split by. */
  readonly resource: string;
}

export type RateLimitAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly retryAfterSeconds: number; readonly reason: string };

/** A short, stable, non-reversible handle for a credential. */
export function credentialIdentity(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 32);
}

/** Whole seconds, at least one. A `Retry-After` of zero invites a hot loop. */
export function wholeSeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

function readSeconds(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  return Number(value);
}

/**
 * How long a 429 asked the caller to wait, in (possibly fractional) seconds.
 *
 * "Your application should rely on the `Retry-After` header or `retry_after`
 * field". Both are read and the LATER instant wins: the document's own examples
 * disagree by design (`Retry-After: 65` beside `retry_after: 64.57`), and a client
 * that honoured the shorter of two answers would be refused again. With neither,
 * `X-RateLimit-Reset-After`, and with nothing at all, one second.
 */
export function requestedWaitSeconds(response: ObservedResponse): number {
  const waits = [response.retryAfter, readSeconds(response.header(DISCORD_RATE_LIMIT_HEADER.retryAfter))]
    .filter((value): value is number => value !== null);
  if (waits.length > 0) return Math.max(...waits);
  return readSeconds(response.header(DISCORD_RATE_LIMIT_HEADER.resetAfter)) ?? 1;
}

export interface ObservedResponse {
  readonly status: number;
  readonly header: (name: string) => string | null;
  /** The 429 body's `retry_after` and `global`, when the body parsed. */
  readonly retryAfter: number | null;
  readonly global: boolean;
}

/**
 * The size at which a sweep runs. NOT a bound on the tables.
 *
 * MEASURED, because the first version of this comment said "bounds" and it does
 * not. `prune` returns immediately below this figure, and above it deletes only
 * what has EXPIRED — so when every remembered window is still live it deletes
 * nothing and the tables keep growing, with every subsequent `observe` rescanning
 * all three. Against the built adapter, one distinct followup route per iteration
 * answered 429 with `retry_after=3600` (so nothing expires): N=1000 -> size 2000
 * at 21.5us/observe, N=5000 -> 10000 at 118.5us, N=20000 -> 40000 at 628.8us.
 * With `retry_after=1` and the clock advanced past it, size stays at 64 after
 * 20000 calls, which is the case the two bounded-table suites exercise: they
 * prove the SWEEP IS CORRECT, not that the table is bounded.
 *
 * THE REAL BOUND IS THE NUMBER OF LIVE WINDOWS, and it is left that way
 * deliberately: a live window is a limit Discord is currently imposing, and
 * forgetting one to cap memory would send a request the far side has already said
 * to hold. Live windows reset within seconds in production. An amortised
 * high-water threshold, or an expiry-ordered structure making a sweep O(expired),
 * would fix the rescan cost; no behavioural case in this suite can tell the two
 * apart, so neither was written on a guess.
 */
export const MAX_REMEMBERED_WINDOWS = 1024;

/** The route a bucket was learned from, and the (credential, bucket) group it belongs to. */
interface RememberedBucket {
  readonly bucket: string;
  readonly group: string;
}

/** One exhausted (credential, bucket, resource) window and the group it holds back. */
interface RememberedWindow {
  readonly until: number;
  readonly group: string;
}

export class DiscordRateLimits {
  private readonly bucketOfRoute = new Map<string, RememberedBucket>();
  private readonly resetAtByBucket = new Map<string, RememberedWindow>();
  private readonly globalResetAt = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  /**
   * Entries held across every table.
   *
   * Bounded by the number of LIVE windows, NOT by `MAX_REMEMBERED_WINDOWS` — see
   * that constant. This figure crossing it is what makes `prune` run at all; it is
   * not a ceiling the sweep restores.
   */
  get size(): number {
    return this.bucketOfRoute.size + this.resetAtByBucket.size + this.globalResetAt.size;
  }

  admit(route: RateLimitRoute): RateLimitAdmission {
    const at = this.now();
    const globalUntil = this.globalResetAt.get(route.identity) ?? 0;
    if (globalUntil > at) {
      return { admitted: false, retryAfterSeconds: wholeSeconds(globalUntil - at), reason: "global rate limit" };
    }
    const bucket = this.bucketOfRoute.get(this.routeKey(route))?.bucket;
    if (bucket === undefined) return { admitted: true };
    const until = this.resetAtByBucket.get(this.bucketKey(route, bucket))?.until ?? 0;
    if (until > at) {
      return { admitted: false, retryAfterSeconds: wholeSeconds(until - at), reason: "bucket exhausted" };
    }
    return { admitted: true };
  }

  /**
   * Learn from one answer. Called for EVERY response that carried headers, not
   * only for a 429: `X-RateLimit-Remaining: 0` on a success is the warning that
   * lets the next request be held back instead of refused.
   */
  observe(route: RateLimitRoute, response: ObservedResponse): void {
    const at = this.now();
    this.prune(at);
    // A route whose answer names no bucket is still limited when it is refused;
    // the route itself stands in for the bucket it did not name.
    const named = response.header(DISCORD_RATE_LIMIT_HEADER.bucket);
    const bucket = named ?? `route:${route.template}`;
    const group = `${route.identity} ${bucket}`;
    if (named !== null || response.status === 429) this.bucketOfRoute.set(this.routeKey(route), { bucket, group });

    const resetAfter = readSeconds(response.header(DISCORD_RATE_LIMIT_HEADER.resetAfter));
    const remaining = readSeconds(response.header(DISCORD_RATE_LIMIT_HEADER.remaining));
    if (named !== null && remaining === 0 && resetAfter !== null) {
      this.resetAtByBucket.set(this.bucketKey(route, bucket), { until: at + resetAfter * 1000, group });
    }

    if (response.status !== 429) return;
    const wait = requestedWaitSeconds(response);
    const global = response.global || response.header(DISCORD_RATE_LIMIT_HEADER.global) === "true";
    if (global) this.globalResetAt.set(route.identity, at + wait * 1000);
    else this.resetAtByBucket.set(this.bucketKey(route, bucket), { until: at + wait * 1000, group });
  }

  /**
   * Forget what no longer limits anything, once the tables are large.
   *
   * A window that has reset carries no information: `admit` already treats it as
   * absent. A ROUTE's remembered bucket is only the way to FIND a window, so once
   * no window in its (credential, bucket) group is live, dropping it changes no
   * answer `admit` gives — and it is the table that grows fastest, because a
   * followup's credential is its interaction token and every slash command brings
   * a new one. Sweeping windows alone would leave one route entry per interaction
   * the process ever answered. An expired global block goes the same way.
   */
  private prune(at: number): void {
    if (this.size < MAX_REMEMBERED_WINDOWS) return;
    const liveGroups = new Set<string>();
    for (const [key, window] of this.resetAtByBucket) {
      if (window.until <= at) this.resetAtByBucket.delete(key);
      else liveGroups.add(window.group);
    }
    for (const [key, remembered] of this.bucketOfRoute) {
      if (!liveGroups.has(remembered.group)) this.bucketOfRoute.delete(key);
    }
    for (const [identity, until] of this.globalResetAt) if (until <= at) this.globalResetAt.delete(identity);
  }

  private routeKey(route: RateLimitRoute): string {
    return `${route.identity} ${route.template}`;
  }

  private bucketKey(route: RateLimitRoute, bucket: string): string {
    return `${route.identity} ${bucket} ${route.resource}`;
  }
}
