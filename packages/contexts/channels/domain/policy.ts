// The tunable numbers, in one place, as data.
//
// Every one of these is a policy decision rather than a rule, so it is a VALUE a
// use case is constructed with rather than a constant compiled into one. That is
// what lets a test drive a lease to expiry in one line instead of waiting five
// minutes, and it is why no rule in this package reads a constant directly.

/** How processing of one inbound event is leased and retried. */
export interface ChannelEventPolicy {
  /** How long a claim holds the row. Must exceed the slowest expected turn. */
  readonly leaseMilliseconds: number;
  /** Backoff applied when a try fails and the row returns to the queue. */
  readonly retryDelayMilliseconds: number;
  /**
   * Retries after which an event is DISCARDED rather than retried.
   *
   * A cap is mandatory, not a nicety: a poison event with no cap is retried for
   * the lifetime of the process, and every try spends a turn.
   */
  readonly maxRetries: number;
  /** Rows one claim pass will consider. Bounds the poll, not the backlog. */
  readonly claimBatchSize: number;
}

/** How a stalled rotating-grant refresh is reclaimed. */
export interface ChannelRefreshPolicy {
  /**
   * How long a `REFRESHING` claim may stand before it is assumed abandoned.
   *
   * Generous by design. Reclaiming sends the row to `REPAIR_REQUIRED`, which
   * needs an operator, so reclaiming a refresh that was merely slow costs more
   * than waiting.
   */
  readonly staleClaimMilliseconds: number;
  /** Recorded on the row so an operator can tell WHY it needs re-authorization. */
  readonly repairCode: string;
}

export interface ChannelsPolicy {
  readonly event: ChannelEventPolicy;
  readonly refresh: ChannelRefreshPolicy;
}

export const DEFAULT_CHANNELS_POLICY: ChannelsPolicy = Object.freeze({
  event: Object.freeze({
    leaseMilliseconds: 5 * 60 * 1000,
    retryDelayMilliseconds: 30 * 1000,
    maxRetries: 5,
    claimBatchSize: 25,
  }),
  refresh: Object.freeze({
    staleClaimMilliseconds: 10 * 60 * 1000,
    repairCode: "REFRESH_ABANDONED",
  }),
});

/**
 * Whether an event that just failed has exhausted its retries.
 *
 * `retryCount` counts retries INCLUDING the one in flight (it is bumped on
 * claim), so the comparison is `>=` against the cap rather than `>`. Getting
 * that boundary wrong is worth one extra turn per poison event, every time.
 */
export function hasExhaustedRetries(retryCount: number, policy: ChannelEventPolicy): boolean {
  return retryCount >= policy.maxRetries;
}
