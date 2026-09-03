// Use case: sweep the ledger for alerts that are owed and not yet sent.
//
// This is the reason the delivery ledger is durable rather than in flight. The
// dispatch that follows a crossing can fail for reasons that have nothing to do
// with the alert — the process restarted, the durable runner was unavailable, a
// lease expired while a transport hung — and none of those should mean the
// operator is never told their budget is gone.
//
// So a periodic pass asks the ledger a question no in-memory queue can answer:
// which crossings still have work outstanding? It is INDEPENDENT of the crossing
// path and of the durable runner, which is what makes it a genuine backstop
// rather than a second copy of the same single point of failure.
//
// IT IS RE-ENTRANT-SAFE WITHOUT A LOCK, because every row it touches goes through
// the claim. The source guards it with a process-local boolean, which stops one
// process from overlapping with itself and does nothing at all about two
// processes — and two processes is what runs in production. The claim is what
// actually makes it safe; the boolean was only ever hiding that.
//
// A FAILURE OF ONE CROSSING DOES NOT STOP THE PASS. Each is counted and the pass
// continues, because the alternative is one permanently unreachable channel
// blocking every other crossing behind it forever.

import { ok, type Result } from "@platos/kernel";

import type { CostMonitoringDependencies } from "./dependencies.js";
import { deliverCrossing } from "./deliver-crossing.js";

export interface ReconcileDeliveriesCommand {
  /** Rows one pass may take. Bounds the pass, not the backlog. */
  readonly limit?: number;
}

export interface ReconciliationReport {
  readonly processed: number;
  readonly failed: number;
}

export async function reconcileDeliveries(
  dependencies: CostMonitoringDependencies,
  command: ReconcileDeliveriesCommand = {},
): Promise<Result<ReconciliationReport>> {
  const now = dependencies.clock.now();
  const due = await dependencies.repository.listPendingCrossings(
    // `PROCESSING` is in the set on purpose: a row whose lease has expired is a
    // row whose dispatcher died, and it is exactly what this pass exists to
    // recover. Leaving it out would make a crashed dispatcher permanent.
    ["PENDING", "FAILED", "PROCESSING"],
    now,
    Math.max(1, Math.trunc(command.limit ?? dependencies.policy.delivery.reconcileBatchSize)),
  );
  // A pass that cannot read its own work queue reports an empty pass rather than
  // an error. It runs on a schedule; the next one is seconds away, and a
  // scheduled task that raises tends to be a scheduled task somebody switches
  // off. The rows it did not see are still owed and still visible.
  if (!due.ok) return ok({ processed: 0, failed: 0 });

  let processed = 0;
  let failed = 0;
  for (const crossing of due.value) {
    const sent = await deliverCrossing(dependencies, {
      scope: crossing.scope,
      eventId: crossing.event.eventId,
    });
    if (sent.ok) processed += 1;
    else failed += 1;
  }
  return ok({ processed, failed });
}
