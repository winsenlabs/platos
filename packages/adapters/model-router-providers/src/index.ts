// The adapter's published surface.
//
// ADR M0.3 §4/§13: an adapter implements ONE owner-supplied port and is the sole
// holder of its vendor client. Only `apps/core-api` may import this package, and
// this package may import no other adapter.
//
// WHAT IS EXPORTED AND WHY IT IS SO LITTLE. The composition root needs a factory
// and the three seams it may fill — a retry policy, a transport, and the clock
// the policy's waits go through. Nothing about a provider, a message, a token
// count or a schema leaves here: every one of those would be a vendor detail
// crossing the boundary this package exists to be.

export {
  createModelRouterProvidersAdapter,
  type ModelRouterProvidersAdapter,
  type ModelRouterProvidersOptions,
} from "./adapter.js";
export {
  DEFAULT_RETRY_POLICY,
  DEFAULT_RETRY_RULES,
  retryPolicy,
  RETRY_ACTIONS,
  RETRY_CAUSES,
  type HttpTransport,
  type RetryAction,
  type RetryCause,
  type RetryPolicy,
  type RetryRule,
  type TransportClock,
} from "./transport.js";
