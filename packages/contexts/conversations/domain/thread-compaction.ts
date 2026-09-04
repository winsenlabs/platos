// Compaction: the state machine that lets a long conversation stay affordable.
//
// WHAT IT IS. Past a threshold, the oldest turns of a thread are replaced in
// every later prompt by one summary. `compactionState` is the lock,
// `compactedUpToTurnId` is the cursor, `summary` is the replacement and
// `compactedAt` is when it happened. `transcript.ts` reads the cursor and starts
// the history after it.
//
// THE LOCK IS A ROW, NOT A MUTEX, AND IT IS A LOCK FOR A REASON. The source
// acquires it with a conditional `updateMany` from IDLE to IN_PROGRESS and
// asserts `count === 1` on every release; two concurrent compactions would each
// summarise a prefix, and whichever finished second would move the cursor past
// turns the first had already replaced — losing everything between the two
// cursors from every later prompt, permanently and silently.
//
// THE CURSOR ONLY MOVES FORWARD, AND THAT IS A SECOND GUARD, NOT THE SAME ONE.
// A caller holding the lock can still hand back a cursor behind where the thread
// already is — a retry of an older job, a replay, a durable callback that
// arrived late. Advancing to it would RE-EXPOSE turns that a summary has already
// replaced, so the prompt would carry both the summary and the turns it stands
// for and the model would see the prefix twice. `CONVERSATIONS_COMPACTION_CURSOR
// _REGRESSED` is its own code because the lock being held tells you nothing
// about whether the cursor is sane.
//
// THE SUMMARY IS CAPPED, BECAUSE IT IS IN EVERY LATER PROMPT. The source asks
// the model to "keep under 500 words" and then stores whatever comes back. An
// instruction is not a ceiling; this is.

import { err, ok, type Result } from "@platos/kernel";

import {
  compactionCursorRegressed,
  compactionInProgress,
  compactionSummaryTooLong,
} from "./errors.js";
import type { TurnId } from "./identifiers.js";
import type { CompactionPolicy } from "./policy.js";
import type { Thread, ThreadCompactionState } from "./thread.js";
import type { Turn } from "./turn.js";

export interface CompactionPlan {
  /** The turns whose text the summary replaces, in conversation order. */
  readonly turns: readonly Turn[];
  readonly cursorTurnId: TurnId;
  readonly cursorSequence: number;
}

/**
 * Take the lock.
 *
 * Answers the thread in IN_PROGRESS, which is what the caller persists. A thread
 * already IN_PROGRESS is refused; that refusal is a `conflict`, not a failure,
 * and the second caller is expected to walk away rather than retry immediately.
 */
export function beginCompaction(thread: Thread): Result<Thread> {
  if (thread.compactionState === "IN_PROGRESS") return err(compactionInProgress(thread.threadId));
  return ok(Object.freeze({ ...thread, compactionState: "IN_PROGRESS" as ThreadCompactionState }));
}

/**
 * Decide what to compact, or decide that nothing is worth compacting.
 *
 * `contextLimit` is how many recent turns stay verbatim; everything older is a
 * candidate. Answering an EMPTY plan rather than an error is deliberate: "not
 * enough to be worth it" is a normal outcome that runs on a schedule, and making
 * it a refusal would fill the log with failures that are the system working.
 */
export function planCompaction(
  turns: readonly Turn[],
  contextLimit: number,
  policy: CompactionPolicy,
): CompactionPlan | null {
  const keep = Math.max(0, contextLimit);
  const candidates = turns.slice(0, Math.max(0, turns.length - keep));
  if (candidates.length < policy.minTurnsToCompact) return null;
  const last = candidates[candidates.length - 1];
  if (last === undefined) return null;
  return Object.freeze({
    turns: Object.freeze([...candidates]),
    cursorTurnId: last.turnId,
    cursorSequence: last.sequence,
  });
}

/**
 * Release the lock without moving the cursor.
 *
 * The path a plan of `null` takes. It is a separate function from the advancing
 * one so that "nothing to do" cannot accidentally write a summary or a cursor.
 */
export function releaseCompaction(thread: Thread): Thread {
  return Object.freeze({ ...thread, compactionState: "IDLE" as ThreadCompactionState });
}

export interface CompactionResult {
  readonly summary: string;
  readonly cursorTurnId: TurnId;
  readonly cursorSequence: number;
  /** The sequence the thread's cursor is already at. Zero when there is none. */
  readonly previousCursorSequence: number;
  readonly at: Date;
}

/**
 * Store the summary, advance the cursor, and release the lock.
 *
 * Two guards, two codes, in this order: an over-long summary is the caller's
 * input and is refused before anything is written; a regressed cursor is a
 * question about the thread's own state. Checking the cheap input first is not
 * an optimization — it means a bad summary never reaches the cursor comparison,
 * so a test that deletes the length guard cannot be rescued by the other one.
 */
export function completeCompaction(
  thread: Thread,
  result: CompactionResult,
  policy: CompactionPolicy,
): Result<Thread> {
  if (result.summary.length > policy.maxSummaryLength) {
    return err(compactionSummaryTooLong(result.summary.length, policy.maxSummaryLength));
  }
  if (result.cursorSequence <= result.previousCursorSequence) {
    return err(compactionCursorRegressed(result.previousCursorSequence, result.cursorSequence));
  }
  return ok(
    Object.freeze({
      ...thread,
      summary: result.summary,
      compactedUpToTurnId: result.cursorTurnId,
      compactedAt: result.at,
      compactionState: "IDLE" as ThreadCompactionState,
    }),
  );
}
