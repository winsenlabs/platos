// The `NotificationQueue` port — where an emitted `NotificationRequested` goes.
//
// The legacy implementation is a Redis list, `mcp:notifications:pending`,
// written with `RPUSH` and drained with `BRPOP` by a loop inside the same Nest
// service. This interface is the enqueue half only. The drain half belongs to
// the delivery adapter, not to this context: ADR M0.3 §1 row 17 ends eventing's
// responsibility at "emits `NotificationRequested`".
//
// `availableAt` IS THE RETRY MECHANISM. The legacy code implements backoff with
// an in-process `setTimeout` that re-pushes onto the list:
//
//     setTimeout(() => { this.redis.rpush(...) }, backoffMs);
//
// which loses every scheduled retry if the process restarts inside the window,
// and whose own comment concedes "bounded — if redis is down we drop". Making
// the delay a PARAMETER of the enqueue moves that decision to the adapter, where
// a delayed queue can hold it durably. The schedule itself
// (`domain/retry-schedule.ts`) is unchanged: same ceiling, same formula, same
// three-attempt limit. Only the mechanism that waits is the adapter's business.
//
// Failure is a value, and it is NOT swallowed here. See
// `route-observed-event.ts` for what the routing pass does with a failed
// enqueue — it is the one place this refactor deliberately reports something the
// legacy code discarded, and it is argued there.

import type { Result } from "@platos/kernel";

import type { NotificationRequested } from "../../domain/index.js";

export interface EnqueuedNotification {
  readonly request: NotificationRequested;
  /** When a consumer may take it. Equal to `requestedAt` for a first attempt. */
  readonly availableAt: Date;
}

export interface NotificationQueue {
  /**
   * Offer one request for delivery.
   *
   * Delivery is at-least-once: an implementation may present the same request
   * twice, and a consumer must tolerate it. That is the legacy guarantee too —
   * a `BRPOP`ped item whose handler crashes mid-flight is simply gone, and the
   * retry path re-pushes an identical frame.
   */
  enqueue(notification: EnqueuedNotification): Promise<Result<void>>;
}
