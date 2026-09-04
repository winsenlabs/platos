// The `EvalRunQueue` port — "eval runs enqueue as durable jobs" (ADR M0.3 §1
// row 14), expressed as a port this context OWNS rather than as a dependency on
// the context that keeps job records.
//
// WHY A PORT AND NOT AN EDGE TO `jobs`. §1 row 14 allows `governance` exactly
// `tenancy`, `agents` and the kernel; `jobs` is not on that list, and adding it
// would make the DAG rule (d) fail. It should not be on the list either: what
// this context needs is not a `Job` ROW, it is the durable execution of a fan-out
// it has already planned and capped. The kernel `DurableRuntime` port is the
// seam for exactly that (§7 decision 9), and the adapter behind this port is what
// turns one `EvalRunRequest` into a dispatch on it. So the arrow points outward
// through an interface this context declares, and the day the runtime changes,
// one adapter changes.
//
// WHY IT IS ENQUEUED AT ALL. The source runs the whole fan-out INSIDE the
// request: a nested loop over threads and criteria, one paid judge call per
// pair, awaited serially, with the HTTP response held open for all of it. A set
// at this context's own pair ceiling is five hundred sequential model calls. The
// request plans the run, admits it against the caps, and hands it over; the
// answer a caller gets is the plan and the handle, not the scores.
//
// ENQUEUEING IS IDEMPOTENT. `idempotencyKey` is computed by the use case over
// the set id, the pair list and the baseline, so a double-clicked "run" button
// costs one run and the second answer says `alreadyQueued`. An implementation
// MUST honour it; answering a fresh handle to a repeated key would spend the
// whole fan-out twice.

import type { EnvironmentScope, Result } from "@platos/kernel";

import type { ActorId, AgentId, AgentVersionId, EvalPair, EvalRunId, GoldenSetId } from "../../domain/index.js";

export interface EvalRunRequest {
  readonly scope: EnvironmentScope;
  readonly goldenSetId: GoldenSetId;
  readonly agentId: AgentId;
  /** Already de-duplicated and inside every cap. See `domain/golden-set.ts`. */
  readonly pairs: readonly EvalPair[];
  readonly baselineVersionId: AgentVersionId | null;
  readonly requestedBy: ActorId;
  /** Stable over the same set, pairs and baseline. Never a timestamp. */
  readonly idempotencyKey: string;
}

export interface EnqueuedEvalRun {
  readonly runId: EvalRunId;
  readonly pairCount: number;
  /** True when this key had already been accepted and nothing new was queued. */
  readonly alreadyQueued: boolean;
}

export interface EvalRunQueue {
  enqueue(request: EvalRunRequest): Promise<Result<EnqueuedEvalRun>>;
}
