// What happens after a delivery fails.
//
// PRESERVED from `McpEventsService.dispatchOne`, which is where the whole policy
// currently lives, tangled into a catch block:
//
//     const retryCount = (p.retryCount ?? 0) + 1;
//     if (retryCount >= MAX_RETRIES) { log permanently; return; }
//     const backoffMs = Math.min(2 ** retryCount * 1000, 30000);
//
// with `MAX_RETRIES = 3`. Extracting it makes the schedule a pure function of
// `retryCount`, which is the only way to test "the third failure is permanent"
// without failing three real webhooks first.
//
// THE LEGACY NAMES ARE KEPT. `retryCount` and `MAX_RETRIES` are the identifiers
// the live system uses, and the WIN-292 vocabulary boundary independently
// requires them: its reserved-word table binds the alternative spelling to the
// external durable-runtime boundary and directs Platos-owned retry metadata to
// name itself in Platos terms. Both pressures point the same way, which is why
// this reads as a restoration rather than as a rename to satisfy a linter.
//
// THE SEQUENCE THIS PRODUCES, spelled out because off-by-one errors in retry
// policy are invisible until an incident. A delivery that has already failed
// `retryCount` times (starting at 0) yields:
//
//   retryCount=0 -> retry after  2s        (2^1 * 1000)
//   retryCount=1 -> retry after  4s        (2^2 * 1000)
//   retryCount=2 -> GIVE UP                (3 >= MAX_RETRIES 3)
//
// So a notification is sent at most THREE times in total — the original plus two
// retries — and the first backoff is two seconds, not one. Both facts are
// surprising enough to pin.
//
// The 30-second ceiling is unreachable at three sends: 2^3 * 1000 is 8000. It is
// kept because it is what the legacy formula says, and because `MAX_RETRIES` is
// the number most likely to be raised later, at which point the ceiling starts
// doing work. Removing it as dead code today would silently uncap that change.

/** The legacy `MAX_RETRIES`. Total sends, not retries after the first. */
export const MAX_RETRIES = 3;

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CEILING_MS = 30_000;

export type RetryDecision =
  | { readonly kind: "retry"; readonly retryCount: number; readonly delayMs: number }
  | { readonly kind: "give-up"; readonly retryCount: number };

/** `min(2^retryCount * 1000, 30000)`, with `retryCount` the 1-based retry number. */
export function backoffMs(retryCount: number): number {
  return Math.min(2 ** retryCount * BACKOFF_BASE_MS, BACKOFF_CEILING_MS);
}

/**
 * Decide what to do after a delivery that had already failed `failedCount`
 * times fails again.
 *
 * The comparison is `>=`, exactly as in the legacy guard: at `MAX_RETRIES` the
 * answer is give-up, not one-more-try.
 */
export function decideRetry(failedCount: number): RetryDecision {
  const retryCount = failedCount + 1;
  if (retryCount >= MAX_RETRIES) return { kind: "give-up", retryCount };
  return { kind: "retry", retryCount, delayMs: backoffMs(retryCount) };
}

/** When a retry decided at `now` becomes due. */
export function retryDueAt(now: Date, decision: Extract<RetryDecision, { kind: "retry" }>): Date {
  return new Date(now.getTime() + decision.delayMs);
}
