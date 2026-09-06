// Use cases: the inbox lease lifecycle — claim, renew, and the three terminal
// outcomes.
//
// One module because they are one protocol. A caller that can claim must be able
// to complete, fail and discard with the SAME `LeaseHold`, and splitting them
// across files would let the hold's shape drift between the half that mints it
// and the half that checks it.
//
// EVERY WRITE RE-READS THE ROW INSIDE THE TRANSACTION. The `LeaseHold` a caller
// carries is a claim about the past; the fence is only real if it is checked
// against the row as it is NOW, in the same transaction as the write. Trusting
// the caller's copy would make the whole generation mechanism decorative — a
// worker returning from a GC pause holds a perfectly well-formed hold for a
// lease it lost minutes ago.
//
// THE RETRY CAP IS APPLIED HERE, NOT IN THE DOMAIN. `failChannelEvent` decides
// between FAILED and DISCARDED by asking the policy whether the retries are
// exhausted. The domain offers both transitions and refuses to choose, because
// which one is right is an operator decision, not a rule.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  claimEvent,
  completeEvent,
  discardEvent,
  eventNotFound,
  failEvent,
  hasExhaustedRetries,
  renewLease,
  type ChannelAppId,
  type ChannelEvent,
  type ChannelEventInboxId,
  type LeaseHold,
  type LeaseOwner,
} from "../domain/index.js";
import type { ChannelsDependencies } from "./dependencies.js";

type Dependencies = Pick<ChannelsDependencies, "repository" | "clock" | "unitOfWork" | "policy">;

export interface ClaimedChannelEvent {
  readonly event: ChannelEvent;
  readonly hold: LeaseHold;
}

/** Re-read inside the transaction. See the header: this is the fence. */
async function currentEvent(
  dependencies: Dependencies,
  inboxId: ChannelEventInboxId,
): Promise<Result<ChannelEvent>> {
  const found = await dependencies.repository.findEvent(inboxId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(eventNotFound(inboxId));
  return ok(found.value);
}

/**
 * Claim the next claimable event for one app.
 *
 * Candidates are read outside the transaction and each claim is retried
 * inside one, walking the list until a claim sticks. A candidate that another
 * worker took between the read and the claim simply fails its compare-and-swap
 * and the walk continues — which is why losing a race costs one iteration
 * rather than an error.
 */
export async function claimNextChannelEvent(
  dependencies: Dependencies,
  appId: ChannelAppId,
  leaseOwner: LeaseOwner,
): Promise<Result<ClaimedChannelEvent | null>> {
  const now = dependencies.clock.now();
  const candidates = await dependencies.repository.findClaimableEvents(
    appId,
    now,
    dependencies.policy.event.claimBatchSize,
  );
  if (!candidates.ok) return err(candidates.error);

  for (const candidate of candidates.value) {
    const claimed = await runResult(dependencies.unitOfWork, async (transaction) => {
      const current = await currentEvent(dependencies, candidate.inboxId);
      if (!current.ok) return current;
      const next = claimEvent(current.value, leaseOwner, dependencies.policy.event.leaseMilliseconds, dependencies.clock.now());
      if (!next.ok) return err<ClaimedChannelEvent>(next.error);
      const saved = await dependencies.repository.saveEvent(next.value.event, transaction);
      if (!saved.ok) return err<ClaimedChannelEvent>(saved.error);
      return ok({ event: saved.value, hold: next.value.hold });
    });
    if (claimed.ok) return ok(claimed.value);
  }
  return ok(null);
}

/** Extend a held lease for a turn that is still running. */
export async function renewChannelEventLease(
  dependencies: Dependencies,
  inboxId: ChannelEventInboxId,
  hold: LeaseHold,
): Promise<Result<ChannelEvent>> {
  return runResult(dependencies.unitOfWork, async (transaction) => {
    const current = await currentEvent(dependencies, inboxId);
    if (!current.ok) return current;
    const next = renewLease(current.value, hold, dependencies.policy.event.leaseMilliseconds, dependencies.clock.now());
    if (!next.ok) return err<ChannelEvent>(next.error);
    return dependencies.repository.saveEvent(next.value, transaction);
  });
}

/** Terminal success. */
export async function completeChannelEvent(
  dependencies: Dependencies,
  inboxId: ChannelEventInboxId,
  hold: LeaseHold,
): Promise<Result<ChannelEvent>> {
  return runResult(dependencies.unitOfWork, async (transaction) => {
    const current = await currentEvent(dependencies, inboxId);
    if (!current.ok) return current;
    const next = completeEvent(current.value, hold, dependencies.clock.now());
    if (!next.ok) return err<ChannelEvent>(next.error);
    return dependencies.repository.saveEvent(next.value, transaction);
  });
}

/**
 * Record a failed try, and decide whether the event lives to be retried.
 *
 * The cap is checked against the row's CURRENT `retryCount` — which the claim
 * already bumped — so the retry in flight counts toward the budget it spent.
 */
export async function failChannelEvent(
  dependencies: Dependencies,
  inboxId: ChannelEventInboxId,
  hold: LeaseHold,
  errorCode: string,
): Promise<Result<ChannelEvent>> {
  return runResult(dependencies.unitOfWork, async (transaction) => {
    const current = await currentEvent(dependencies, inboxId);
    if (!current.ok) return current;
    const now = dependencies.clock.now();
    const next = hasExhaustedRetries(current.value.retryCount, dependencies.policy.event)
      ? discardEvent(current.value, hold, errorCode, now)
      : failEvent(current.value, hold, errorCode, dependencies.policy.event.retryDelayMilliseconds, now);
    if (!next.ok) return err<ChannelEvent>(next.error);
    return dependencies.repository.saveEvent(next.value, transaction);
  });
}

/**
 * Terminal failure by explicit decision — a poison event whose retries are not
 * exhausted but which a caller knows must never run (an unparseable body, an
 * event for a revoked installation).
 */
export async function discardChannelEvent(
  dependencies: Dependencies,
  inboxId: ChannelEventInboxId,
  hold: LeaseHold,
  errorCode: string,
): Promise<Result<ChannelEvent>> {
  return runResult(dependencies.unitOfWork, async (transaction) => {
    const current = await currentEvent(dependencies, inboxId);
    if (!current.ok) return current;
    const next = discardEvent(current.value, hold, errorCode, dependencies.clock.now());
    if (!next.ok) return err<ChannelEvent>(next.error);
    return dependencies.repository.saveEvent(next.value, transaction);
  });
}
