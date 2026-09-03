// The numbers an installation may move without changing code.
//
// Every value below is a literal buried in the extraction source — a two-minute
// lease, a thirty-second backoff, a batch of fifty, a ninety-day retention. Each
// is a real operational choice, and each is currently spelled once in the middle
// of a method where nobody can find it to change it.
//
// They are a POLICY VALUE passed in, for the reason `providers` gives about its
// catalogue: a rule that takes its constants as a parameter is exercisable at any
// setting, so "the lease expired" is a test rather than a wait.

/** How a claimed delivery holds and releases its row. */
export interface DeliveryPolicy {
  /**
   * Lease length. Two minutes in the source.
   *
   * It must exceed the longest a transport can take — the send timeouts are
   * fifteen seconds — or a slow but healthy dispatcher loses its own row
   * mid-send and its result is discarded as a stale claim.
   */
  readonly leaseSeconds: number;
  /** How long a failed delivery waits before it is offered again. */
  readonly retryBackoffSeconds: number;
  /** Rows one reconciliation pass may take. Bounds the pass, not the backlog. */
  readonly reconcileBatchSize: number;
}

/** How the pre-spend guard treats its cached caps. */
export interface GuardPolicy {
  /**
   * How long a cached cap list is trusted (ADR M0.3 §7 decision 3, option b).
   *
   * The decision accepts staleness on the CAP — a limit an operator changed
   * seconds ago — and refuses it on the SPEND, which is read live every time.
   * The asymmetry is the point: caps change by hand, minutes apart at most,
   * while spend changes every turn.
   */
  readonly capCacheSeconds: number;
  /**
   * Whether a storage failure lets the dispatch through.
   *
   * True in the source, and kept true: the guard is on the hot path, and a
   * counter blip that stalled every turn would be a worse outage than the spend
   * it failed to stop. It is settable because an installation that would rather
   * stop than overspend is making a legitimate different choice.
   */
  readonly failOpen: boolean;
}

export interface CostMonitoringPolicy {
  readonly delivery: DeliveryPolicy;
  readonly guard: GuardPolicy;
  /** Widest page a caller may ask for, whatever it requests. */
  readonly maxPageSize: number;
}

export const DEFAULT_COST_MONITORING_POLICY: CostMonitoringPolicy = Object.freeze({
  delivery: Object.freeze({
    leaseSeconds: 120,
    retryBackoffSeconds: 30,
    reconcileBatchSize: 50,
  }),
  guard: Object.freeze({
    capCacheSeconds: 30,
    failOpen: true,
  }),
  maxPageSize: 200,
});
