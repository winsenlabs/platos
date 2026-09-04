// Forking a thread, and why a fork copies nothing.
//
// THE SCHEMA COMMENT IS THE WHOLE ARGUMENT: `forkedTurnIds` holds "ordered
// references to canonical ancestor Turns", and it exists because copying them
// would "duplicate billable ledger rows". A fork that cloned its ancestry would
// double every `Turn.costCents` and every `Step` in the prefix, and the second
// copy would be indistinguishable from money genuinely spent. So a fork is three
// columns and an array of ids, and `transcript.ts` reads through them.
//
// THE CONSEQUENCE EVERY READER PAYS. A forked thread's turns come from TWO
// places — the ancestor ids in array order, then its own rows by sequence — so
// there is no single query that answers "this thread's turns". `forkedTurnIds`
// is ORDERED and its order is authoritative: the array is the prefix, and
// re-sorting it by any property of the referenced rows would silently reorder a
// conversation.
//
// TWO CEILINGS, TWO CODES, AND THEY BOUND DIFFERENT THINGS.
//
//   FAN-OUT is how many forks one thread may have. The source has this one
//   (`if (forkCount >= 10) throw new ThreadForkLimitError()`) and it stops one
//   thread being branched into a thousand.
//
//   DEPTH is how long a chain of forks may get. The source has NO such ceiling,
//   so a fork of a fork of a fork is unbounded, and each level lengthens the
//   prefix every later prompt has to walk. It is introduced here and said so.
//
// A thread inside the fan-out ceiling can still breach the depth one, and the
// reverse, which is exactly why they cannot share a code.

import { err, ok, type Result } from "@platos/kernel";

import { forkCeilingExceeded, forkDepthExceeded, forkTurnForeign } from "./errors.js";
import type { ThreadId, TurnId } from "./identifiers.js";
import type { ThreadPolicy } from "./policy.js";
import type { Thread } from "./thread.js";
import type { Turn } from "./turn.js";

export interface ForkPlan {
  readonly parentThreadId: ThreadId;
  readonly forkedUpToTurnId: TurnId;
  /** The prefix, in conversation order. References, never copies. */
  readonly forkedTurnIds: readonly TurnId[];
  /** How deep the CHILD sits. A fork of the root is depth 1. */
  readonly depth: number;
}

export interface ForkRequest {
  readonly parent: Thread;
  /** Every turn of the parent, in conversation order, ancestry included. */
  readonly parentTurns: readonly Turn[];
  readonly forkedUpToTurnId: TurnId;
  /** How many forks the parent already has. The fan-out ceiling reads this. */
  readonly existingForkCount: number;
  /** The parent's own depth. Zero for a thread that was never forked. */
  readonly parentDepth: number;
}

/**
 * Plan a fork, or refuse it.
 *
 * The boundary turn must be IN the parent — `Thread.forkedUpToTurn` is
 * `onDelete: Restrict`, so a foreign id would pin an unrelated thread's row
 * alive forever as well as producing a fork whose history is somebody else's.
 * The source checks membership by looking the turn up under the thread; the
 * refusal here carries both ids so an operator can see which pair was wrong.
 */
export function planFork(request: ForkRequest, policy: ThreadPolicy): Result<ForkPlan> {
  if (request.existingForkCount >= policy.maxForksPerThread) {
    return err(forkCeilingExceeded(request.existingForkCount + 1, policy.maxForksPerThread));
  }
  const depth = request.parentDepth + 1;
  if (depth > policy.maxForkDepth) return err(forkDepthExceeded(depth, policy.maxForkDepth));

  const boundary = request.parentTurns.findIndex((turn) => turn.turnId === request.forkedUpToTurnId);
  if (boundary === -1) {
    return err(forkTurnForeign(request.parent.threadId, request.forkedUpToTurnId));
  }

  const prefix = request.parentTurns.slice(0, boundary + 1).map((turn) => turn.turnId);
  return ok(
    Object.freeze({
      parentThreadId: request.parent.threadId,
      forkedUpToTurnId: request.forkedUpToTurnId,
      forkedTurnIds: Object.freeze(prefix),
      depth,
    }),
  );
}

/** Stamp a freshly opened thread with the plan. The child's own turns start at 1. */
export function applyFork(child: Thread, plan: ForkPlan): Thread {
  return Object.freeze({
    ...child,
    parentThreadId: plan.parentThreadId,
    forkedUpToTurnId: plan.forkedUpToTurnId,
    forkedTurnIds: plan.forkedTurnIds,
  });
}

/**
 * A thread's whole turn count: its inherited prefix plus its own rows.
 *
 * Published because there is no single query that answers it and every caller
 * that guesses gets it wrong in the same direction — `_count.turns` alone
 * reports a fork as if the conversation started at the branch point.
 */
export function totalTurnCount(thread: Thread, ownTurnCount: number): number {
  return thread.forkedTurnIds.length + ownTurnCount;
}
