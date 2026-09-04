// `ToolCall` — one invocation, in its place in a turn's transcript.
//
// ADR M0.3 §7 decision 4 settled a contradiction between the source proposals
// and put this row here: THE EXECUTOR IS THE WRITER. `conversations` writes the
// `Step` and this context writes the calls hanging off it, because the thing
// that knows whether a call started, how long it took and how it ended is the
// thing that made it. `@@unique([stepId, sequence])` is what makes the
// transcript an ordered list rather than a bag.
//
// THE SEQUENCE IS PER STEP AND IT IS DENSE. A step's calls are numbered from
// zero with no gaps, so a reader can reconstruct the order without sorting on a
// timestamp — which matters because `executeBatch` runs a step's calls in
// PARALLEL and their `startedAt` values interleave. Ordering a parallel batch
// by time would present a model's transcript in an order the model never
// produced.
//
// `status` IS `WorkStatus` AND IT IS SHARED WITH JOBS AND ERASURES. Five
// values, one meaning each, and only four of the transitions between them are
// legal. Modelling that as a free `String` is how a call ends up SUCCEEDED with
// an error message.

import { err, ok, type Result } from "@platos/kernel";

import { callSequenceConflict, callTransitionInvalid } from "./errors.js";
import type { StepId, ToolCallId, ToolId, ToolName } from "./identifiers.js";

/** `WorkStatus`, transcribed. */
export const CALL_STATUSES = ["PENDING", "ACTIVE", "SUCCEEDED", "FAILED", "CANCELLED"] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];

/** The three states from which nothing further happens. */
export const TERMINAL_CALL_STATUSES: readonly CallStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED"];

export function isTerminal(status: CallStatus): boolean {
  return TERMINAL_CALL_STATUSES.includes(status);
}

export interface ToolCall {
  readonly toolCallId: ToolCallId;
  readonly stepId: StepId;
  /** Null when the name resolved to no `Tool` row — the call still happened. */
  readonly toolId: ToolId | null;
  readonly sequence: number;
  readonly toolName: ToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly status: CallStatus;
  readonly retryCount: number;
  readonly error: string | null;
  readonly latencyMs: number | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * The legal moves.
 *
 * PENDING may start or be cancelled before it ever runs. ACTIVE may reach any
 * of the three terminals. A terminal state moves nowhere: a retry is a NEW
 * call with an incremented `retryCount`, not a resurrection of the old one, so
 * the transcript keeps the failure that caused the retry.
 */
const TRANSITIONS: Readonly<Record<CallStatus, readonly CallStatus[]>> = Object.freeze({
  PENDING: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
});

export function canTransition(from: CallStatus, to: CallStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The next free position in a step, or a conflict if the caller named one taken. */
export function nextSequence(existing: readonly ToolCall[]): number {
  return existing.reduce((highest, call) => Math.max(highest, call.sequence + 1), 0);
}

export function admitSequence(
  existing: readonly ToolCall[],
  stepId: StepId,
  sequence: number,
): Result<number> {
  if (existing.some((call) => call.stepId === stepId && call.sequence === sequence)) {
    return err(callSequenceConflict(stepId, sequence));
  }
  return ok(sequence);
}

export function beginCall(call: ToolCall, at: Date): Result<ToolCall> {
  if (!canTransition(call.status, "ACTIVE")) {
    return err(callTransitionInvalid(call.status, "ACTIVE"));
  }
  return ok({ ...call, status: "ACTIVE", startedAt: at });
}

/**
 * Finish a call.
 *
 * `latencyMs` is DERIVED from the two instants rather than accepted from the
 * caller. The source measures `Date.now() - startTime` at eleven separate
 * return points inside one method; each is correct and any future twelfth might
 * not be. Deriving it here means a call that never started reports null latency
 * instead of the age of the universe.
 *
 * A success clears `error` and a failure clears `result`. Carrying both is the
 * state a reader cannot interpret, and it is reachable from a backend that
 * returns a payload alongside an error field.
 */
export function completeCall(
  call: ToolCall,
  outcome:
    | { readonly status: "SUCCEEDED"; readonly result: unknown }
    | { readonly status: "FAILED"; readonly error: string }
    | { readonly status: "CANCELLED"; readonly error: string | null },
  at: Date,
): Result<ToolCall> {
  if (!canTransition(call.status, outcome.status)) {
    return err(callTransitionInvalid(call.status, outcome.status));
  }
  const latencyMs = call.startedAt === null ? null : Math.max(0, at.getTime() - call.startedAt.getTime());
  if (outcome.status === "SUCCEEDED") {
    return ok({ ...call, status: "SUCCEEDED", result: outcome.result, error: null, latencyMs, completedAt: at });
  }
  return ok({
    ...call,
    status: outcome.status,
    result: null,
    error: outcome.error,
    latencyMs,
    completedAt: at,
  });
}

/** A retry is a new position in the transcript that remembers its ancestry. */
export function retryOf(call: ToolCall, toolCallId: ToolCallId, sequence: number, at: Date): ToolCall {
  return {
    toolCallId,
    stepId: call.stepId,
    toolId: call.toolId,
    sequence,
    toolName: call.toolName,
    arguments: call.arguments,
    result: null,
    status: "PENDING",
    retryCount: call.retryCount + 1,
    error: null,
    latencyMs: null,
    startedAt: null,
    completedAt: null,
    createdAt: at,
  };
}

/** Transcript order: dense sequence within a step. Never by time. */
export function byTranscriptOrder(left: ToolCall, right: ToolCall): number {
  if (left.stepId !== right.stepId) return left.stepId < right.stepId ? -1 : 1;
  return left.sequence - right.sequence;
}
