// The drain: queued envelopes in, analytical rows out.
//
// A LOOP, BECAUSE A SINGLE READ IS A THROUGHPUT CEILING. One claim per scheduled
// run caps steady-state delivery at the claim size per run REGARDLESS of how
// much work the installation does. At a 500-envelope claim on an hourly
// schedule, an installation completing more than about eight turns a minute
// accumulates a backlog it can never work off even with a perfectly healthy
// store — and pruning only removes acknowledged envelopes, so the queue grows
// without bound while nothing reports its depth. The pass keeps claiming until
// the queue is empty, the row budget is spent, or the wall clock runs out, and
// it reports the depth either way.
//
// THE ORDER OF THE THREE GUARDS IS LOAD-BEARING.
//
//   1. SINK FIRST. An unavailable sink means claim nothing. Claiming only to
//      fail every envelope would spend the whole retry budget on an outage the
//      operator already has to fix, and could park a healthy backlog.
//   2. ERASURE SECOND, before any delivery in the batch. The register is asked
//      once per batch, and it FAILS CLOSED: a lookup that cannot run refuses the
//      pass rather than delivering blind.
//   3. DELIVERY LAST, one envelope at a time, each settled with its own outcome.
//
// EVERY CLAIMED ENVELOPE GETS EXACTLY ONE OUTCOME. `reportIsConserved` states
// that as arithmetic, and this file is written so it holds by construction:
// every branch below either settles, discards, or is unreachable.

import { err, ok, type Result } from "@platos/kernel";

import {
  addressedEndUserId,
  decideEnvelope,
  deliveryFailed,
  deliverySucceeded,
  deliveryUndeliverable,
  envelopeMalformed,
  isSinkAvailable,
  retentionCutoff,
  wasParked,
  type DrainBudget,
  type DrainReport,
  type EnvelopeId,
  type ProjectionRows,
  type QueueDepth,
  type SinkHealth,
} from "../domain/index.js";
import type { ObservabilityDependencies } from "./dependencies.js";
import { probeSink } from "./probe-sink.js";
import type { QueuedEnvelope } from "./ports/index.js";

/** A mutable tally the loop accumulates; frozen into a `DrainReport` at the end. */
interface Tally {
  claimed: number;
  delivered: number;
  retried: number;
  parked: number;
  ignored: number;
  pruned: number;
  discarded: number;
  passes: number;
  stoppedBecause: string | null;
}

function newTally(): Tally {
  return {
    claimed: 0,
    delivered: 0,
    retried: 0,
    parked: 0,
    ignored: 0,
    pruned: 0,
    discarded: 0,
    passes: 0,
    stoppedBecause: null,
  };
}

function sealed(tally: Tally, depth: QueueDepth | null): DrainReport {
  return Object.freeze({
    claimed: tally.claimed,
    delivered: tally.delivered,
    retried: tally.retried,
    parked: tally.parked,
    ignored: tally.ignored,
    pruned: tally.pruned,
    discarded: tally.discarded,
    passes: tally.passes,
    depth,
    stoppedBecause: tally.stoppedBecause,
  });
}

/**
 * The depth, attached to EVERY report including the ones that did nothing.
 *
 * `parked` counts envelopes parked during THIS pass, so one parked at 09:00 was
 * announced once and every later pass reported zero — the claim query filters on
 * pending. A depth that could not be read stays null: a missing count is not the
 * same claim as zero.
 */
async function readDepth(dependencies: ObservabilityDependencies): Promise<QueueDepth | null> {
  const depth = await dependencies.outbox.depth();
  return depth.ok ? depth.value : null;
}

/** What a single envelope's payload resolved to, with its queue bookkeeping. */
interface Resolved {
  readonly envelope: QueuedEnvelope;
  readonly rows: ProjectionRows | null;
  readonly outcomeIfUndeliverable: ReturnType<typeof deliveryUndeliverable> | null;
  readonly ignoredBecause: string | null;
}

function resolve(envelope: QueuedEnvelope): Resolved {
  const decision = decideEnvelope(envelope.event);
  if (decision.kind === "project") {
    return { envelope, rows: decision.rows, outcomeIfUndeliverable: null, ignoredBecause: null };
  }
  if (decision.kind === "ignore") {
    return { envelope, rows: null, outcomeIfUndeliverable: null, ignoredBecause: decision.reason };
  }
  return {
    envelope,
    rows: null,
    outcomeIfUndeliverable: deliveryUndeliverable(envelope, decision.error),
    ignoredBecause: null,
  };
}

/**
 * Envelopes in this batch whose subject the organization has erased.
 *
 * Grouped by organization because the register is organization-scoped and one
 * pass spans every tenant with queued work. An `err` from any group aborts the
 * whole pass: see this file's header, guard 2.
 */
async function erasedEnvelopeIds(
  dependencies: ObservabilityDependencies,
  resolved: readonly Resolved[],
): Promise<Result<ReadonlySet<EnvelopeId>>> {
  const byOrganization = new Map<string, Map<string, EnvelopeId[]>>();
  for (const entry of resolved) {
    if (entry.rows === null) continue;
    const endUserId = addressedEndUserId(entry.rows);
    if (endUserId === null) continue;
    const organizationId = entry.envelope.event.scope.organizationId;
    const bySubject = byOrganization.get(organizationId) ?? new Map<string, EnvelopeId[]>();
    bySubject.set(endUserId, [...(bySubject.get(endUserId) ?? []), entry.envelope.envelopeId]);
    byOrganization.set(organizationId, bySubject);
  }
  const erased = new Set<EnvelopeId>();
  for (const [organizationId, bySubject] of byOrganization) {
    const hits = await dependencies.erasedSubjects.erasedSubjects({
      organizationId,
      endUserIds: [...bySubject.keys()],
    });
    // Fail closed. A register that cannot answer is not an answer of "no".
    if (!hits.ok) return err(hits.error);
    for (const endUserId of hits.value) {
      for (const envelopeId of bySubject.get(endUserId) ?? []) erased.add(envelopeId);
    }
  }
  return ok(erased);
}

async function deliverBatch(
  dependencies: ObservabilityDependencies,
  budget: DrainBudget,
  batch: readonly QueuedEnvelope[],
  tally: Tally,
): Promise<Result<void>> {
  const resolved = batch.map(resolve);
  const erased = await erasedEnvelopeIds(dependencies, resolved);
  if (!erased.ok) return err(erased.error);

  if (erased.value.size > 0) {
    const ids = [...erased.value];
    const discarded = await dependencies.outbox.discard(ids);
    if (!discarded.ok) return err(discarded.error);
    // The TALLY counts the envelopes THIS PASS accounted for, not the rows the
    // queue happened to remove. The two differ when a concurrent drain removed
    // one first, and using the queue's number there would break the conservation
    // law — an envelope claimed, skipped, and counted nowhere. The queue's own
    // number is still reported, because "asked to destroy 4, destroyed 3" is a
    // fact an operator may want.
    tally.discarded += erased.value.size;
    dependencies.logger.log(
      "warn",
      "discarded queued projections for erased subjects; an undelivered projection must never re-insert an erased identity",
      { addressed: erased.value.size, removed: discarded.value },
    );
  }

  for (const entry of resolved) {
    if (erased.value.has(entry.envelope.envelopeId)) continue;

    if (entry.ignoredBecause !== null) {
      // Not ours. Acknowledged so it stops being claimed, and counted so a
      // drain that only ever sees other drains' envelopes is visibly doing
      // nothing rather than invisibly doing nothing.
      const outcome = deliverySucceeded(entry.envelope, dependencies.clock.now());
      const settled = await dependencies.outbox.settle(entry.envelope.envelopeId, outcome);
      if (!settled.ok) return err(settled.error);
      tally.ignored += 1;
      continue;
    }

    if (entry.outcomeIfUndeliverable !== null) {
      const settled = await dependencies.outbox.settle(
        entry.envelope.envelopeId,
        entry.outcomeIfUndeliverable,
      );
      if (!settled.ok) return err(settled.error);
      tally.parked += 1;
      dependencies.logger.log("error", "parked an undeliverable queued projection", {
        envelopeId: entry.envelope.envelopeId,
        event: entry.envelope.event.name,
        code: entry.outcomeIfUndeliverable.lastErrorCode,
      });
      continue;
    }

    const rows = entry.rows ?? null;
    // Unreachable: `resolve` returns rows, an ignore reason, or an undeliverable
    // outcome, and the two above are already handled. Kept as a settle rather
    // than a throw so a future fourth decision cannot silently drop an envelope.
    if (rows === null) {
      const outcome = deliveryUndeliverable(
        entry.envelope,
        envelopeMalformed("envelope resolved to no decision"),
      );
      const settled = await dependencies.outbox.settle(entry.envelope.envelopeId, outcome);
      if (!settled.ok) return err(settled.error);
      tally.parked += 1;
      continue;
    }

    const inserted = await dependencies.sink.insert(rows);
    const now = dependencies.clock.now();
    if (inserted.ok) {
      const settled = await dependencies.outbox.settle(
        entry.envelope.envelopeId,
        deliverySucceeded(entry.envelope, now),
      );
      if (!settled.ok) return err(settled.error);
      tally.delivered += 1;
      continue;
    }

    const outcome = deliveryFailed(entry.envelope, now, budget.maxRetries, inserted.error);
    const settled = await dependencies.outbox.settle(entry.envelope.envelopeId, outcome);
    if (!settled.ok) return err(settled.error);
    if (wasParked(outcome)) {
      tally.parked += 1;
      dependencies.logger.log("error", "parked a queued projection after exhausting its retries", {
        envelopeId: entry.envelope.envelopeId,
        retryCount: outcome.retryCount,
        code: outcome.lastErrorCode,
      });
    } else {
      tally.retried += 1;
    }
  }
  return ok(undefined);
}

export interface DrainProjectionsCommand {
  /** Narrow this call's ceilings. Never widens past the configured budget. */
  readonly budget?: Partial<DrainBudget>;
  /** A pre-read sink health, so a caller that just probed does not probe twice. */
  readonly health?: SinkHealth;
}

/**
 * Deliver queued projections.
 *
 * Returns a report rather than a count. "Delivered 40, parked 3" is
 * operationally a different sentence from "delivered 40", and the second half is
 * the one an alert fires on.
 */
export async function drainProjections(
  dependencies: ObservabilityDependencies,
  command: DrainProjectionsCommand = {},
): Promise<Result<DrainReport>> {
  const budget = narrowBudget(dependencies.budget, command.budget);
  const tally = newTally();

  const health = command.health ?? (await probeSink(dependencies));
  if (!isSinkAvailable(health)) {
    // Nothing claimed and nothing lost; the envelopes stay queued.
    dependencies.logger.log(
      health.status === "disabled" ? "info" : "warn",
      "drain claimed nothing: the analytical sink is not available",
      { status: health.status, detail: health.detail },
    );
    tally.stoppedBecause = `sink ${health.status}`;
    return ok(sealed(tally, await readDepth(dependencies)));
  }

  const startedAt = dependencies.clock.now().getTime();
  while (tally.claimed < budget.maxRows) {
    const take = Math.min(budget.claimBatchSize, budget.maxRows - tally.claimed);
    const claimed = await dependencies.outbox.claim({ limit: take, asOf: dependencies.clock.now() });
    if (!claimed.ok) return err(claimed.error);
    if (claimed.value.length === 0) {
      tally.stoppedBecause = "queue is empty";
      break;
    }
    tally.claimed += claimed.value.length;
    tally.passes += 1;

    const delivered = await deliverBatch(dependencies, budget, claimed.value, tally);
    if (!delivered.ok) return err(delivered.error);

    // A short read means the queue is empty; anything else means keep going
    // until one of the two budgets stops us.
    if (claimed.value.length < take) {
      tally.stoppedBecause = "queue is empty";
      break;
    }
    if (dependencies.clock.now().getTime() - startedAt >= budget.deadlineMs) {
      tally.stoppedBecause = `deadline reached after ${tally.claimed} envelopes`;
      break;
    }
  }
  if (tally.claimed >= budget.maxRows && tally.stoppedBecause === null) {
    tally.stoppedBecause = `row budget (${budget.maxRows}) reached`;
  }

  const pruned = await dependencies.outbox.prune(retentionCutoff(dependencies.clock.now()));
  if (!pruned.ok) return err(pruned.error);
  tally.pruned = pruned.value;

  return ok(sealed(tally, await readDepth(dependencies)));
}

/**
 * A caller may only NARROW the configured budget.
 *
 * A drain invoked from an operator surface must not be able to raise the
 * installation's ceiling: the ceilings exist to bound what one call can do to a
 * store, and a caller who can raise them has no ceiling at all.
 */
export function narrowBudget(configured: DrainBudget, requested: Partial<DrainBudget> | undefined): DrainBudget {
  const narrow = (value: number | undefined, ceiling: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 1
      ? Math.min(ceiling, Math.floor(value))
      : ceiling;
  return {
    maxRows: narrow(requested?.maxRows, configured.maxRows),
    claimBatchSize: narrow(requested?.claimBatchSize, configured.claimBatchSize),
    maxRetries: narrow(requested?.maxRetries, configured.maxRetries),
    deadlineMs: narrow(requested?.deadlineMs, configured.deadlineMs),
  };
}
