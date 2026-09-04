// `Turn` — the message PAIR, and the third row this context is sole writer of.
//
// THERE IS NO MESSAGE TABLE, AND THAT IS THE FACT EVERYTHING ELSE FOLLOWS FROM.
// The canonical schema has no `Message` model: a turn carries `inputText` (what
// the end user said) and `outputText` (what the agent answered), plus `input`
// and `output` for the structured forms of each. So one row is one exchange, and
// what the extraction source calls a "message id" is a `Turn.id` with a side.
// A caller that thinks in messages reads two of them off one row.
//
// A TURN IS OPENED BEFORE IT IS ANSWERED. `openTurn` writes the user side and
// leaves the agent side null with status PENDING; `settleTurn` writes the answer
// and moves the status. That ordering is what makes a turn that crashed halfway
// visible as a FAILED row with its input intact rather than as nothing at all,
// and it is why `outputText` is nullable while `inputText` effectively is not.
//
// THE SEQUENCE IS ALLOCATED UNDER A LOCK, NOT GUESSED. `@@unique([threadId,
// sequence])` makes a race a constraint violation rather than a silent overwrite,
// and the source takes `SELECT id FROM "Thread" WHERE id = $1 FOR UPDATE` before
// reading the highest sequence. That lock is the repository's business — this
// file states the RULE the lock exists to keep: the next sequence is one more
// than the highest, and a collision is `CONVERSATIONS_TURN_SEQUENCE_TAKEN`.
//
// THE VERSION AND ITS BUCKET ARE PINNED PER TURN. `agentVersionId` plus
// `versionBucket` record which version answered and whether it was the current
// one or the canary. `agents` decides; this row is where the decision is kept,
// and it is the axis every canary judgement is later drawn along.
//
// COST AND USAGE ARE DERIVED, NEVER SUPPLIED. `settleTurn` takes the STEPS and
// computes both. `turn-cost.ts` says why at length; the short version is that
// the source keeps a turn-level running total beside per-step rows and the two
// disagreed by 2.7x on cache reads. There is no parameter here to disagree with.

import { err, ok, type JsonValue, type Result } from "@platos/kernel";

import {
  turnAborted,
  turnInputInvalid,
  turnInputTooLarge,
} from "./errors.js";
import type { AgentVersionId, IdempotencyKey, ThreadId, TurnId } from "./identifiers.js";
import type { TurnPolicy } from "./policy.js";
import type { Step } from "./step.js";
import { sumStepUsage, type StepUsage } from "./step-usage.js";
import { rollUpTurnCost, type TurnCost } from "./turn-cost.js";
import { transition, type WorkStatus } from "./work-status.js";

/** `AgentVersionBucket` in the canonical schema, spelled as its owner spells it. */
export const VERSION_BUCKETS = ["CURRENT", "CANARY"] as const;

export type VersionBucket = (typeof VERSION_BUCKETS)[number];

export interface Turn {
  readonly turnId: TurnId;
  readonly threadId: ThreadId;
  /** A revision or a sub-thread anchor. Null on an ordinary turn. */
  readonly parentTurnId: TurnId | null;
  readonly agentVersionId: AgentVersionId;
  readonly versionBucket: VersionBucket;
  readonly sequence: number;
  readonly inputText: string | null;
  readonly outputText: string | null;
  /** The structured form of the input. An object root, as the column requires. */
  readonly input: Readonly<Record<string, JsonValue>> | null;
  readonly output: Readonly<Record<string, JsonValue>> | null;
  readonly thinkingContent: string | null;
  readonly status: WorkStatus;
  /** The durable-runtime handle, when this turn was run out of process. */
  readonly externalRuntimeId: string | null;
  readonly idempotencyKey: IdempotencyKey | null;
  readonly cost: TurnCost;
  readonly usage: StepUsage;
  readonly latencyMs: number | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export interface TurnDraft {
  readonly turnId: TurnId;
  readonly threadId: ThreadId;
  readonly agentVersionId: AgentVersionId;
  readonly versionBucket: VersionBucket;
  /** One more than the highest in the thread. Allocated under the thread lock. */
  readonly sequence: number;
  readonly parentTurnId?: TurnId | null;
  readonly inputText?: string | null;
  readonly input?: Readonly<Record<string, JsonValue>> | null;
  readonly idempotencyKey?: IdempotencyKey | null;
  readonly at: Date;
}

/**
 * Admit the input half of a turn.
 *
 * TWO CODES BECAUSE THERE ARE TWO DECISIONS: a turn with no input at all has
 * nothing to run and is the caller's bug; a turn with a megabyte of input is
 * well formed and over a ceiling an operator can raise. The source refuses
 * neither, and builds a prompt out of whatever arrives.
 */
export function admitTurnInput(
  inputText: string | null | undefined,
  input: Readonly<Record<string, JsonValue>> | null | undefined,
  policy: TurnPolicy,
): Result<{ readonly inputText: string | null; readonly input: Readonly<Record<string, JsonValue>> | null }> {
  const text = inputText ?? null;
  const structured = input ?? null;
  if ((text === null || text.trim() === "") && structured === null) {
    return err(turnInputInvalid("a turn must carry input text or structured input"));
  }
  const bytes = (text ?? "").length + (structured === null ? 0 : JSON.stringify(structured).length);
  if (bytes > policy.maxInputBytes) return err(turnInputTooLarge(bytes, policy.maxInputBytes));
  return ok({ inputText: text, input: structured });
}

/** Open a turn with its user side written and its agent side empty. */
export function openTurn(draft: TurnDraft, policy: TurnPolicy): Result<Turn> {
  const admitted = admitTurnInput(draft.inputText, draft.input, policy);
  if (!admitted.ok) return err(admitted.error);

  return ok(
    Object.freeze({
      turnId: draft.turnId,
      threadId: draft.threadId,
      parentTurnId: draft.parentTurnId ?? null,
      agentVersionId: draft.agentVersionId,
      versionBucket: draft.versionBucket,
      sequence: draft.sequence,
      inputText: admitted.value.inputText,
      outputText: null,
      input: admitted.value.input,
      output: null,
      thinkingContent: null,
      status: "PENDING" as WorkStatus,
      externalRuntimeId: null,
      idempotencyKey: draft.idempotencyKey ?? null,
      cost: rollUpTurnCost([]),
      usage: sumStepUsage([]),
      latencyMs: null,
      startedAt: null,
      completedAt: null,
      createdAt: draft.at,
    }),
  );
}

/** Mark a turn as running. The first step has opened. */
export function beginTurn(turn: Turn, at: Date): Result<Turn> {
  const moved = transition(turn.turnId, turn.status, "ACTIVE");
  if (!moved.ok) return err(moved.error);
  return ok(Object.freeze({ ...turn, status: moved.value, startedAt: at }));
}

export interface TurnSettlement {
  readonly status: WorkStatus;
  readonly outputText?: string | null;
  readonly output?: Readonly<Record<string, JsonValue>> | null;
  readonly thinkingContent?: string | null;
  readonly externalRuntimeId?: string | null;
  /** EVERY step of the turn, sub-agent steps included. The only cost input. */
  readonly steps: readonly Step[];
  readonly completedAt: Date;
}

/**
 * Close a turn with its answer, and DERIVE what it cost and what it used.
 *
 * `steps` is the whole record and there is no usage or cost parameter beside it.
 * A caller holding a turn-level figure from somewhere else cannot pass it here,
 * which is the single mechanism that makes the two numbers unable to disagree.
 */
export function settleTurn(turn: Turn, settlement: TurnSettlement): Result<Turn> {
  const moved = transition(turn.turnId, turn.status, settlement.status);
  if (!moved.ok) return err(moved.error);

  const startedAt = turn.startedAt ?? turn.createdAt;
  return ok(
    Object.freeze({
      ...turn,
      status: moved.value,
      outputText: settlement.outputText ?? turn.outputText,
      output: settlement.output ?? turn.output,
      thinkingContent: settlement.thinkingContent ?? turn.thinkingContent,
      externalRuntimeId: settlement.externalRuntimeId ?? turn.externalRuntimeId,
      cost: rollUpTurnCost(settlement.steps),
      usage: sumStepUsage(settlement.steps.map((step) => step.usage)),
      latencyMs: settlement.completedAt.getTime() - startedAt.getTime(),
      completedAt: settlement.completedAt,
    }),
  );
}

/**
 * Abandon a turn.
 *
 * CANCELLED, not FAILED, and the steps already taken are still rolled up: an
 * abort is billed for what it used. The source throws an `AbortError` out of the
 * generator and settles the turn in a catch block that cannot see the steps, so
 * an abandoned turn loses its money.
 */
export function abandonTurn(turn: Turn, steps: readonly Step[], at: Date): Result<Turn> {
  const settled = settleTurn(turn, { status: "CANCELLED", steps, completedAt: at });
  if (!settled.ok) return err(settled.error);
  return settled;
}

/** The refusal a caller sees when it asks to continue an abandoned turn. */
export function abortedError(turn: Turn): ReturnType<typeof turnAborted> {
  return turnAborted(turn.turnId);
}

/** The step ceiling in force, agent request clamped to the installation's. */
export function stepCeiling(requested: number | null, policy: TurnPolicy): number {
  const asked = requested === null || !Number.isInteger(requested) || requested < 1
    ? policy.defaultStepsPerTurn
    : requested;
  return Math.min(asked, policy.maxStepsPerTurn);
}
