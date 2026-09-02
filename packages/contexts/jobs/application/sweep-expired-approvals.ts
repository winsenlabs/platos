// Use case: flip pending approvals whose deadline has passed to `timed_out`.
//
// USES THE STRICT PREDICATE (`isSweepable`, `>`), NOT the read-path one
// (`hasElapsed`, `>=`). The live sweep and the live read path disagree at exactly
// the deadline instant and this extraction preserves both; see the header of
// `domain/approval.ts` for why that divergence is reported rather than resolved.
//
// EVERY ROW IS JUDGED INDEPENDENTLY. One row that cannot be flipped does not stop
// the pass — the sweep runs every five minutes and a row it could not take this
// time is simply taken next time. Aborting the pass on the first failure would
// let a single stuck row hold back the whole queue indefinitely.
//
// A ROW THAT WAS RESOLVED UNDER US IS NOT AN ERROR. Between the read and the
// write a human may have approved it, and the repository's guarded update reports
// that as `false`. The human won; the sweep counts it as untouched and moves on.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import { isSweepable, timeOutApproval, type Approval } from "../domain/index.js";
import type { JobsDependencies } from "./dependencies.js";

export interface SweepScopeReport {
  readonly scope: EnvironmentScope;
  readonly examined: number;
  readonly timedOut: number;
  /** Rows that were sweepable but could not be taken, with the reason. */
  readonly retained: readonly { readonly approvalId: string; readonly reason: string }[];
}

export interface SweepReport {
  readonly scopesScanned: number;
  readonly totalTimedOut: number;
  readonly perScope: readonly SweepScopeReport[];
}

async function timeOutOne(
  dependencies: JobsDependencies,
  scope: EnvironmentScope,
  approval: Approval,
  now: Date,
): Promise<{ readonly timedOut: boolean; readonly reason: string | null }> {
  const expired = timeOutApproval(approval, now);
  if (!expired.ok) return { timedOut: false, reason: expired.error.code };

  const written = await dependencies.unitOfWork.run((transaction) =>
    dependencies.approvals.resolve(scope, expired.value, transaction),
  );
  if (!written.ok) return { timedOut: false, reason: written.error.code };
  // `false` means a human decided it first. Not a failure, and not retained.
  return { timedOut: written.value, reason: null };
}

/** Sweep one environment. */
export async function sweepExpiredApprovals(
  dependencies: JobsDependencies,
  scope: EnvironmentScope,
): Promise<Result<SweepScopeReport>> {
  const pending = await dependencies.approvals.findPending(scope);
  if (!pending.ok) return err(pending.error);

  const now = dependencies.clock.now();
  const sweepable = pending.value.filter((approval) => isSweepable(approval, now));
  const retained: { approvalId: string; reason: string }[] = [];
  let timedOut = 0;

  for (const approval of sweepable) {
    const outcome = await timeOutOne(dependencies, scope, approval, now);
    if (outcome.timedOut) timedOut += 1;
    else if (outcome.reason !== null) {
      retained.push({ approvalId: approval.approvalId, reason: outcome.reason });
    }
  }

  return ok({ scope, examined: sweepable.length, timedOut, retained });
}

/**
 * Sweep every environment that currently holds a pending approval.
 *
 * The scope enumeration is the one cross-tenant read this context performs; it is
 * its own repository method so it is impossible to write by accident and easy to
 * find when auditing. A scope that fails is recorded and the pass continues, for
 * the same reason a row that fails does.
 */
export async function sweepAllScopes(dependencies: JobsDependencies): Promise<Result<SweepReport>> {
  const scopes = await dependencies.approvals.findScopesWithPending();
  if (!scopes.ok) return err(scopes.error);

  const perScope: SweepScopeReport[] = [];
  let totalTimedOut = 0;

  for (const scope of scopes.value) {
    const report = await sweepExpiredApprovals(dependencies, scope);
    if (report.ok) {
      perScope.push(report.value);
      totalTimedOut += report.value.timedOut;
    } else {
      perScope.push({
        scope,
        examined: 0,
        timedOut: 0,
        retained: [{ approvalId: "(scope)", reason: report.error.code }],
      });
    }
  }

  return ok({ scopesScanned: scopes.value.length, totalTimedOut, perScope });
}
