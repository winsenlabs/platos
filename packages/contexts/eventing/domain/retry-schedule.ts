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
// the attempt number, which is the only way to test "the fourth failure is
// permanent" without failing three real webhooks first.
//
// THE SEQUENCE THIS PRODUCES, spelled out because off-by-one errors in retry
// policy are invisible until an incident. An attempt that has failed `n` times
// (n starting at 0) yields:
//
//   n=0 -> retry after  2s        (2^1 * 1000)
//   n=1 -> retry after  4s        (2^2 * 1000)
//   n=2 -> GIVE UP                (retryCount 3 >= MAX_RETRIES 3)
//
// So a notification is attempted at most THREE times in total, and the first
// backoff is two seconds, not one. Both facts are surprising enough to pin.
//
// The 30-second ceiling is unreachable at three attempts — 2^3 * 1000 is 8000.
// It is kept because it is what the legacy formula says, and because MAX_ATTEMPTS
// is the number most likely to be raised later, at which point the ceiling starts
// doing work. Removing it as dead code today would silently uncap that change.

/** The legacy `MAX_RETRIES`. Total attempts, not retries after the first. */
export const MAX_ATTEMPTS = 3;

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CEILING_MS = 30_000;

export type RetryDecision =
  | { readonly kind: "retry"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "give-up"; readonly attempts: number };

/** `min(2^attempt * 1000, 30000)`, with `attempt` the 1-based retry number. */
export function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * BACKOFF_BASE_MS, BACKOFF_CEILING_MS);
}

/**
 * Decide what to do after the attempt numbered `failedAttempt` (0-based) failed.
 *
 * The comparison is `>=`, exactly as in the legacy guard: at `MAX_ATTEMPTS` the
 * answer is give-up, not one-more-try.
 */
export function decideRetry(failedAttempt: number): RetryDecision {
  const attempt = failedAttempt + 1;
  if (attempt >= MAX_ATTEMPTS) return { kind: "give-up", attempts: attempt };
  return { kind: "retry", attempt, delayMs: backoffMs(attempt) };
}

/** When a retry decided at `now` becomes due. */
export function retryDueAt(now: Date, decision: Extract<RetryDecision, { kind: "retry" }>): Date {
  return new Date(now.getTime() + decision.delayMs);
}
