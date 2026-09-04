// `Step` — one model call inside a turn, and the row this context is sole
// writer of (ADR M0.3 §1 row 16).
//
// A STEP IS THE UNIT OF BILLING, WHICH IS WHY IT IS A ROW AT ALL. A turn that
// used four tools made five model calls, each with its own usage, its own
// latency and its own price card, and a turn-level total cannot be taken apart
// again afterwards. `@@unique([turnId, sequence])` is what makes the trace
// replayable in order, and `onDelete: Cascade` from the turn is what makes an
// erased turn take its steps with it without this context walking them.
//
// THE COST IS STORED, THE TOTAL IS NOT. `Step.costCents` holds what `providers`
// priced this call at. `Turn.costCents` is the SUM of them, computed by
// `turn-cost.ts` from the step rows, and no caller may supply it. That is the
// same rule `step-usage.ts` applies to tokens and it is there for the same
// measured reason.
//
// A STEP IS SETTLED ONCE. `retryCount` is the schema's answer to a call that had
// to be made again: the row keeps its identity and counts the retries, rather
// than a second row appearing at the same sequence. So a step that has reached
// SUCCEEDED, FAILED or CANCELLED refuses a second settlement, and a retry
// increments a counter on a step that is still open.

import { err, money, ok, zero, type Money, type Result } from "@platos/kernel";

import { stepAlreadySettled } from "./errors.js";
import type { ModelPriceId, StepId, TurnId } from "./identifiers.js";
import { requireExplainedRates, type StepRateBook } from "./step-rates.js";
import { NO_STEP_USAGE, type StepUsage } from "./step-usage.js";
import { isTerminal, transition, type WorkStatus } from "./work-status.js";

export interface Step {
  readonly stepId: StepId;
  readonly turnId: TurnId;
  /** One-based, dense, and unique within the turn. Step 1 is the turn's own call. */
  readonly sequence: number;
  /** The model string as it was routed, `<provider>:<model>` or a bare name. */
  readonly model: string;
  readonly status: WorkStatus;
  readonly retryCount: number;
  readonly usage: StepUsage;
  /** Null until `providers` has priced it. Never a guess. */
  readonly cost: Money | null;
  /** Which card. Null on a step that failed before a price was resolved. */
  readonly modelPriceId: ModelPriceId | null;
  readonly rates: StepRateBook;
  readonly latencyMs: number | null;
  /** Operator-facing text. Never a stack trace and never a credential. */
  readonly error: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export interface StepDraft {
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly sequence: number;
  readonly model: string;
  readonly startedAt: Date;
}

/** Open a step. It starts ACTIVE: the model call is already in flight. */
export function openStep(draft: StepDraft): Step {
  return Object.freeze({
    stepId: draft.stepId,
    turnId: draft.turnId,
    sequence: draft.sequence,
    model: draft.model,
    status: "ACTIVE" as WorkStatus,
    retryCount: 0,
    usage: NO_STEP_USAGE,
    cost: null,
    modelPriceId: null,
    rates: {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    },
    latencyMs: null,
    error: null,
    startedAt: draft.startedAt,
    completedAt: null,
    createdAt: draft.startedAt,
  });
}

export interface StepSettlement {
  readonly status: WorkStatus;
  readonly usage: StepUsage;
  readonly cost: Money | null;
  readonly modelPriceId: ModelPriceId | null;
  readonly rates: StepRateBook;
  readonly error: string | null;
  readonly completedAt: Date;
}

/**
 * Close a step with what it consumed and what it cost.
 *
 * Two guards, two codes. The transition table refuses a second settlement
 * (`CONVERSATIONS_STEP_ALREADY_SETTLED`); the rate rule refuses a row that
 * cannot explain its own charge (`CONVERSATIONS_STEP_RATE_MISSING`). They are
 * checked in that order because a settled step's rates are not this caller's
 * business.
 */
export function settleStep(step: Step, settlement: StepSettlement): Result<Step> {
  const moved = transition(step.stepId, step.status, settlement.status);
  if (!moved.ok) return err(moved.error);

  const rates = requireExplainedRates(settlement.usage, settlement.rates);
  if (!rates.ok) return err(rates.error);

  const latencyMs = step.startedAt === null ? null : settlement.completedAt.getTime() - step.startedAt.getTime();
  return ok(
    Object.freeze({
      ...step,
      status: moved.value,
      usage: settlement.usage,
      cost: settlement.cost,
      modelPriceId: settlement.modelPriceId,
      rates: rates.value,
      latencyMs,
      error: settlement.error,
      completedAt: settlement.completedAt,
    }),
  );
}

/**
 * Count one retry of a step that is still open.
 *
 * A settled step refuses, with the SAME code a second settlement gets, because
 * both are the one mistake: writing to a row that is finished. The two are told
 * apart by the caller's method, not by the code.
 */
export function retryStep(step: Step): Result<Step> {
  if (isTerminal(step.status)) return err(stepAlreadySettled(step.stepId, step.status));
  return ok(Object.freeze({ ...step, retryCount: step.retryCount + 1 }));
}

/** What a step cost, or nothing when it was never priced. */
export function stepCost(step: Step): Money {
  return step.cost ?? zero();
}

/** The zero amount, in the currency a caller is working in. Never a bare `0`. */
export function noCost(): Money {
  return money(0n);
}
