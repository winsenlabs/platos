// Use case: a delivery failed — decide whether to try again.
//
// The retry half of `McpEventsService.dispatchOne`, lifted out of its catch
// block. The schedule itself is pure (`domain/retry-schedule.ts`); this is the
// use case that consults it and, when the answer is "retry", puts the SAME
// request back on the queue with an incremented retryCount and a delayed
// `availableAt`.
//
// WHY THE REQUEST IS RE-ENQUEUED RATHER THAN HELD. The legacy version holds the
// retry in an in-process `setTimeout`, which loses it on restart and whose own
// comment admits "bounded — if redis is down we drop". Handing it back to the
// queue with a due time makes the wait the queue's problem, where it can be
// durable. The observable schedule is identical: same retry count, same
// backoff, same give-up point.
//
// GIVING UP IS A SUCCESS, NOT AN ERROR. `ok({ kind: "give-up" })` is the
// terminal outcome after three sends, exactly as the legacy `return` after
// the permanent-failure log. A caller must be able to tell "this notification is
// finished, unsuccessfully" from "the queue is broken", and only the second is
// an `err`.

import { err, ok, type Result } from "@platos/kernel";

import {
  decideRetry,
  retryDueAt,
  type NotificationRequested,
  type RetryDecision,
} from "../domain/index.js";
import type { EventingDependencies } from "./dependencies.js";

export interface DeliveryFailureOutcome {
  readonly decision: RetryDecision;
  /** The re-enqueued request; null when the schedule gave up. */
  readonly rescheduled: NotificationRequested | null;
}

export async function recordDeliveryFailure(
  dependencies: EventingDependencies,
  request: NotificationRequested,
): Promise<Result<DeliveryFailureOutcome>> {
  const decision = decideRetry(request.retryCount);
  if (decision.kind === "give-up") return ok({ decision, rescheduled: null });

  const now = dependencies.clock.now();
  const next: NotificationRequested = Object.freeze({
    ...request,
    retryCount: decision.retryCount,
    requestedAt: new Date(now.getTime()),
  });

  const enqueued = await dependencies.queue.enqueue({
    request: next,
    availableAt: retryDueAt(now, decision),
  });
  if (!enqueued.ok) return err(enqueued.error);
  return ok({ decision, rescheduled: next });
}
