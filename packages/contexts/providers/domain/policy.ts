// The tunable limits, in one place, as data.
//
// Every value here is transcribed from the behaviour the running
// `ProviderHealthService` and model-catalogue service already have. They are a
// POLICY VALUE passed into a use case, not a module constant read from an
// ambient environment, because a limit read from a process variable inside a
// domain rule is untestable and is exactly the coupling ADR M0.3 §2 bans.

export interface ProviderHealthPolicy {
  /** How long a successful liveness result stays usable. */
  readonly healthySeconds: number;
  /**
   * How long a FAILED liveness result stays usable.
   *
   * Much shorter than the success window, and deliberately so: a failure is
   * usually a key an operator is in the middle of fixing, and making them wait
   * out the success window to see their fix is the difference between a working
   * page and a broken one.
   */
  readonly unhealthySeconds: number;
  /** Budget for one liveness call before it is abandoned. */
  readonly probeTimeoutMs: number;
}

export interface ModelListPolicy {
  /** How long a fetched model list stays usable. */
  readonly freshSeconds: number;
  /**
   * How long an EMPTY result from a failed fetch stays usable.
   *
   * Short, but not zero. Caching the failure briefly is what stops a broken
   * upstream from being called once per page load; keeping it short is what lets
   * a recovered upstream reappear without an operator waiting ten minutes.
   */
  readonly failureSeconds: number;
  /** Budget for one model-list call. Shorter than the probe: it is on a
   *  page's critical path, and a curated list is always available behind it. */
  readonly fetchTimeoutMs: number;
}

export interface ProvidersPolicy {
  readonly health: ProviderHealthPolicy;
  readonly modelList: ModelListPolicy;
}

const MINUTE_SECONDS = 60;

export const DEFAULT_PROVIDERS_POLICY: ProvidersPolicy = Object.freeze({
  health: Object.freeze({
    healthySeconds: 5 * MINUTE_SECONDS,
    unhealthySeconds: MINUTE_SECONDS,
    probeTimeoutMs: 10_000,
  }),
  modelList: Object.freeze({
    freshSeconds: 10 * MINUTE_SECONDS,
    failureSeconds: 30,
    fetchTimeoutMs: 5_000,
  }),
});
