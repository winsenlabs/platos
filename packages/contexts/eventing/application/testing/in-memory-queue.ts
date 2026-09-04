// An in-memory `NotificationQueue`, and a `DestinationScreen` a test can steer.
//
// The queue keeps everything it was handed, in order, so a test asserts on WHAT
// was emitted rather than on a call count. `takeAll` drains it, which is what
// makes "the second routing pass emitted nothing new" expressible.
//
// `ScriptedDestinationScreen` defaults to ADMITTING. That is the safe default
// for a double precisely because it is the unsafe default for the real thing: a
// test that means to exercise a refusal must say so, and a test that forgets to
// configure the screen gets the permissive behaviour and therefore cannot
// accidentally pass an SSRF assertion it never set up.

import { err, ok, type Result } from "@platos/kernel";

import { queueUnavailable, screenUnavailable } from "../../domain/index.js";
import type {
  DestinationScreen,
  EnqueuedNotification,
  NotificationQueue,
  ScreenedDestination,
} from "../ports/index.js";

export class InMemoryNotificationQueue implements NotificationQueue {
  private readonly items: EnqueuedNotification[] = [];
  private failure: string | null = null;

  /** Make the NEXT enqueue fail with EVENTING_QUEUE_UNAVAILABLE. */
  failNext(reason = "injected"): void {
    this.failure = reason;
  }

  async enqueue(notification: EnqueuedNotification): Promise<Result<void>> {
    const reason = this.failure;
    this.failure = null;
    if (reason !== null) return err(queueUnavailable(reason));
    this.items.push(notification);
    return ok(undefined);
  }

  /** Everything enqueued so far, oldest first. Non-destructive. */
  all(): readonly EnqueuedNotification[] {
    return [...this.items];
  }

  /** Everything enqueued so far, and reset. */
  takeAll(): readonly EnqueuedNotification[] {
    return this.items.splice(0, this.items.length);
  }
}

export class ScriptedDestinationScreen implements DestinationScreen {
  private readonly refusals = new Map<string, string>();
  private unavailable: string | null = null;
  readonly screened: string[] = [];

  /** Refuse this exact URL with `reason`. */
  refuse(url: string, reason = "resolves to private address space"): void {
    this.refusals.set(url, reason);
  }

  /** Make every screening fail to DECIDE, which must not fail open. */
  breakScreen(reason = "resolver timeout"): void {
    this.unavailable = reason;
  }

  async screen(url: string): Promise<Result<ScreenedDestination>> {
    this.screened.push(url);
    if (this.unavailable !== null) return err(screenUnavailable(this.unavailable));
    const reason = this.refusals.get(url);
    if (reason !== undefined) return ok({ admitted: false, reason });
    return ok({ admitted: true, reason: null });
  }
}
