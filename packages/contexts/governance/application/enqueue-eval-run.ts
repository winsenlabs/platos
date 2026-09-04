// Use case: hand a golden-set run to the durable seam.
//
// ADR M0.3 §1 row 14: "Eval runs enqueue as durable jobs." This is that
// sentence, and the difference between it and what the source does is the whole
// point of the file.
//
// THE SOURCE RUNS THE FAN-OUT INSIDE THE REQUEST. `GoldenSetService.run` loops
// threads by criteria, awaits one paid judge call per pair serially, and holds
// the HTTP response open for all of it. At this context's own pair ceiling that
// is five hundred sequential model calls behind one request; the source has no
// ceiling at all, so it is however many pairs the set names. A client timeout
// mid-run leaves the work running, half the evals written, and no handle to ask
// about it.
//
// HERE THE REQUEST PLANS AND HANDS OVER. It resolves the set, re-checks the caps
// against the set as STORED (a set written before a cap was lowered must not be
// runnable), confirms the agent is still visible, computes an idempotency key,
// and enqueues. What the caller gets back is the plan and the handle, not the
// scores.
//
// THE IDEMPOTENCY KEY IS COMPUTED FROM WHAT THE RUN IS, NOT FROM WHEN IT WAS
// ASKED FOR. Set id, pair list in plan order, and baseline version. A
// double-clicked "run" button costs one run, and `alreadyQueued` says which
// answer the second click got. A timestamp in the key would make every click a
// new run, which is the same as having no key.
//
// THE KILL SWITCH IS CHECKED HERE TOO, NOT ONLY IN `run-judge.ts`. A disabled
// install must not be able to queue work that will be refused one at a time
// later, having already paid for the dispatch.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitGoldenSet,
  evalsDisabled,
  goldenSetNotFound,
  planPairs,
  type AgentVersionId,
  type EvalPair,
  type GoldenSetId,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { GovernanceDependencies } from "./dependencies.js";
import { requireVisibleAgent } from "./golden-sets.js";
import type { ActorId } from "../domain/index.js";
import type { EnqueuedEvalRun } from "./ports/index.js";

export interface EnqueueEvalRunCommand {
  readonly authorization: unknown;
  readonly goldenSetId: GoldenSetId;
  readonly requestedBy: ActorId;
  readonly baselineVersionId?: AgentVersionId | null;
}

export interface EvalRunPlanned extends EnqueuedEvalRun {
  readonly goldenSetId: GoldenSetId;
  readonly pairs: readonly EvalPair[];
}

export async function enqueueEvalRun(
  dependencies: GovernanceDependencies,
  command: EnqueueEvalRunCommand,
): Promise<Result<EvalRunPlanned>> {
  if (!dependencies.policy.evals.enabled) return err(evalsDisabled());
  const grant = verifyOperator(dependencies, command.authorization);
  if (!grant.ok) return err(grant.error);
  const scope = grant.value.scope;

  const stored = await dependencies.goldenSets.findById(scope, command.goldenSetId);
  if (!stored.ok) return err(stored.error);
  if (stored.value === null) return err(goldenSetNotFound(command.goldenSetId));

  // Re-admit the STORED set. A set written when the pair ceiling was higher must
  // not become runnable again simply because it is already in the table.
  const admitted = admitGoldenSet(
    {
      agentId: stored.value.agentId,
      name: stored.value.name,
      description: stored.value.description,
      threadIds: stored.value.threadIds,
      criterionIds: stored.value.criterionIds,
    },
    dependencies.policy.goldenSets,
  );
  if (!admitted.ok) return err(admitted.error);

  const visible = await requireVisibleAgent(dependencies, command.authorization, admitted.value.agentId);
  if (!visible.ok) return err(visible.error);

  const pairs = planPairs(admitted.value);
  const baselineVersionId = command.baselineVersionId ?? null;
  const enqueued = await dependencies.evalRuns.enqueue({
    scope,
    goldenSetId: stored.value.goldenSetId,
    agentId: admitted.value.agentId,
    pairs,
    baselineVersionId,
    requestedBy: command.requestedBy,
    idempotencyKey: evalRunIdempotencyKey(stored.value.goldenSetId, pairs, baselineVersionId),
  });
  if (!enqueued.ok) return err(enqueued.error);
  return ok({ ...enqueued.value, goldenSetId: stored.value.goldenSetId, pairs });
}

/**
 * The key two identical run requests share.
 *
 * Built from the set id, every pair in plan order, and the baseline. It is a
 * plain joined string rather than a digest because this context owns no hashing
 * port and a domain that reaches for one would be importing infrastructure; the
 * adapter behind `EvalRunQueue` may digest it, and a key's only requirement is
 * that identical requests produce identical keys.
 */
export function evalRunIdempotencyKey(
  goldenSetId: GoldenSetId,
  pairs: readonly EvalPair[],
  baselineVersionId: AgentVersionId | null,
): string {
  const rendered = pairs.map((pair) => `${pair.threadId}:${pair.criterionId}`).join("|");
  return `eval-run/${goldenSetId}/${baselineVersionId ?? "no-baseline"}/${rendered}`;
}
