// `Budget` — one spending cap, and the rules that admit one.
//
// A cap says: within this environment, for this subject, over this period, spend
// at most this much and complete at most this many turns. Two independent
// dimensions, either of which can be left uncapped by setting it to zero, and a
// cap with BOTH at zero is legal and blocks nothing — it exists only to carry
// alert thresholds, which is how an operator asks to be told about spend they do
// not want to stop.
//
// EVERY VALIDATION HERE IS A `Result`, NOT A THROW. The source raises bare
// `Error("invalid period: fortnight")` and the surface above it decides what to
// return by testing the message with `startsWith`. That is a status code chosen
// by string prefix; `domain/errors.ts` records what it fails open on.
//
// THE THRESHOLD CEILING IS 200 PERCENT, NOT 100, AND THAT IS DELIBERATE. An
// operator who wants to hear about a cap that has been overridden and is running
// at 150% can ask for it. The floor is exclusive of zero: a 0% threshold would
// cross the instant the window opened, on every window, forever.

import { err, ok, type EnvironmentId, type Result } from "@platos/kernel";

import { budgetInvalid, budgetTargetInvalid, thresholdInvalid } from "./errors.js";
import {
  asCostIdentifier,
  type ActorId,
  type AgentId,
  type BudgetId,
  type SkillSlug,
} from "./identifiers.js";
import {
  EVERY_USER,
  isBudgetSubject,
  isBudgetTier,
  type BudgetSubject,
  type BudgetTarget,
  type BudgetTier,
} from "./budget-scope.js";
import { admitPeriod, type BudgetPeriod } from "./window.js";

/** The thresholds a cap fires at when an operator names none. */
export const DEFAULT_ALERT_THRESHOLDS: readonly number[] = Object.freeze([50, 80, 100]);

/** Inclusive ceiling on one threshold, in percent. */
export const MAX_ALERT_THRESHOLD = 200;

/** Ceiling on how many thresholds one cap may carry. */
export const MAX_ALERT_THRESHOLDS = 16;

export interface Budget {
  readonly budgetId: BudgetId;
  readonly environmentId: EnvironmentId;
  readonly target: BudgetTarget;
  readonly period: BudgetPeriod;
  /** Zero or below means spend is not capped. */
  readonly limitCents: number;
  /** Zero or below means completed turns are not capped. */
  readonly runsLimit: number;
  /** Ascending, deduplicated. */
  readonly alertThresholds: readonly number[];
  readonly enabled: boolean;
  /** While in the future, a breached cap does not block. */
  readonly overrideUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What an operator supplies to write a cap. */
export interface BudgetIntake {
  readonly subject: string;
  readonly targetId?: string;
  readonly period: string;
  readonly limitCents: number;
  readonly runsLimit?: number;
  readonly alertThresholds?: readonly number[];
  readonly tier?: string;
  readonly skillSlug?: string | null;
  readonly agentId?: string | null;
  readonly enabled?: boolean;
  readonly legacyWebhookUrl?: string | null;
  readonly legacyEmails?: string | null;
}

export interface AdmittedBudget {
  readonly target: BudgetTarget;
  readonly period: BudgetPeriod;
  readonly limitCents: number;
  readonly runsLimit: number;
  readonly alertThresholds: readonly number[];
  readonly enabled: boolean;
}

/**
 * Admit the thresholds.
 *
 * Sorted and deduplicated on the way in, so a cap written as `[100, 50, 50]`
 * and one written as `[50, 100]` are the same cap. Without that, the duplicate
 * would produce two crossing checks against one unique constraint, and the
 * second would take the constraint-violation path on every single evaluation.
 */
export function admitThresholds(values: readonly number[] | undefined): Result<readonly number[]> {
  if (values === undefined) return ok(DEFAULT_ALERT_THRESHOLDS);
  if (values.length > MAX_ALERT_THRESHOLDS) {
    return err(
      budgetInvalid(`at most ${MAX_ALERT_THRESHOLDS} alert thresholds may be set`, [
        { field: "alertThresholds", code: "too_many", message: "too many thresholds" },
      ]),
    );
  }
  const admitted = new Set<number>();
  for (const value of values) {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return err(thresholdInvalid(`invalid alert threshold: ${value}`, value));
    }
    if (value <= 0 || value > MAX_ALERT_THRESHOLD) {
      return err(thresholdInvalid(`invalid alert threshold: ${value}`, value));
    }
    admitted.add(value);
  }
  return ok([...admitted].sort((left, right) => left - right));
}

function admitLimit(value: number, field: string): Result<number> {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return err(
      budgetInvalid(`invalid ${field}: ${value}`, [
        { field, code: "invalid", message: `${field} must be a non-negative whole number` },
      ]),
    );
  }
  return ok(value);
}

/**
 * Admit an intake into a cap that can be written.
 *
 * The order is: shape first, then the two cross-field rules. Both cross-field
 * rules exist because the alternative is a cap that looks written and enforces
 * nothing:
 *
 *   A `*` target on anything but a `user` cap matches no subject.
 *   A `skillSlug` on an `llm` cap filters on a dimension that tier never reads.
 */
export function admitBudget(intake: BudgetIntake): Result<AdmittedBudget> {
  if (!isBudgetSubject(intake.subject)) {
    return err(
      budgetInvalid(`invalid scopeType: ${intake.subject}`, [
        { field: "subject", code: "invalid", message: "subject must be scope, agent or user" },
      ]),
    );
  }
  const period = admitPeriod(intake.period);
  if (!period.ok) return err(period.error);

  const limitCents = admitLimit(intake.limitCents, "limitCents");
  if (!limitCents.ok) return err(limitCents.error);
  const runsLimit = admitLimit(intake.runsLimit ?? 0, "runsLimit");
  if (!runsLimit.ok) return err(runsLimit.error);

  const thresholds = admitThresholds(intake.alertThresholds);
  if (!thresholds.ok) return err(thresholds.error);

  const tier = intake.tier ?? "llm";
  if (!isBudgetTier(tier)) {
    return err(
      budgetInvalid(`invalid tier: ${tier}`, [
        { field: "tier", code: "invalid", message: "tier must be llm or skill" },
      ]),
    );
  }

  const targetId = (intake.targetId ?? "").trim();
  if (targetId === EVERY_USER && intake.subject !== "user") {
    return err(
      budgetTargetInvalid(
        'targetId="*" is only valid for a user cap',
        intake.subject,
        targetId,
      ),
    );
  }
  if (intake.subject === "agent" && targetId === "") {
    return err(budgetTargetInvalid("an agent cap must name an agent", intake.subject, targetId));
  }

  const skillSlug = (intake.skillSlug ?? "").trim();
  if (skillSlug !== "" && tier !== "skill") {
    return err(
      budgetInvalid(`skillSlug is only valid on a skill-tier cap (got tier=${tier})`, [
        { field: "skillSlug", code: "invalid", message: "skillSlug requires tier=skill" },
      ]),
    );
  }
  const agentId = (intake.agentId ?? "").trim();

  return ok({
    target: {
      subject: intake.subject satisfies BudgetSubject,
      targetId,
      tier: tier satisfies BudgetTier,
      skillSlug: skillSlug === "" ? null : asCostIdentifier<SkillSlug>(skillSlug),
      agentId: agentId === "" ? null : asCostIdentifier<AgentId>(agentId),
      legacyWebhookUrl: intake.legacyWebhookUrl ?? null,
      legacyEmails: intake.legacyEmails ?? null,
      overrideBy: null,
    },
    period: period.value,
    limitCents: limitCents.value,
    runsLimit: runsLimit.value,
    alertThresholds: thresholds.value,
    enabled: intake.enabled ?? true,
  });
}

/**
 * Apply an admitted intake to an existing cap.
 *
 * `overrideBy` is carried FORWARD, not taken from the intake. An operator
 * editing a cap's limit does not thereby become the author of an override
 * someone else authorised, and an intake cannot set the field at all.
 */
export function applyIntake(budget: Budget, admitted: AdmittedBudget, now: Date): Budget {
  return {
    ...budget,
    target: { ...admitted.target, overrideBy: budget.target.overrideBy },
    period: admitted.period,
    limitCents: admitted.limitCents,
    runsLimit: admitted.runsLimit,
    alertThresholds: admitted.alertThresholds,
    enabled: admitted.enabled,
    updatedAt: now,
  };
}

/** Is an override in force at `at`? */
export function overrideActive(budget: Budget, at: Date): boolean {
  return budget.overrideUntil !== null && budget.overrideUntil.getTime() > at.getTime();
}

/**
 * Grant or clear a temporary override.
 *
 * Zero minutes CLEARS, and clearing also clears the author: leaving the last
 * authoriser's name on a cap with no override in force reads, in an audit, as
 * though the override were still theirs and still open.
 */
export function withOverride(
  budget: Budget,
  minutes: number,
  actor: ActorId,
  now: Date,
): Result<Budget> {
  if (!Number.isFinite(minutes) || minutes < 0) {
    return err(
      budgetInvalid(`invalid override minutes: ${minutes}`, [
        { field: "minutes", code: "invalid", message: "minutes must be zero or more" },
      ]),
    );
  }
  const until = minutes > 0 ? new Date(now.getTime() + minutes * 60_000) : null;
  return ok({
    ...budget,
    overrideUntil: until,
    target: { ...budget.target, overrideBy: until === null ? null : actor },
    updatedAt: now,
  });
}

/** Disable and tombstone a cap. The row survives; its enforcement does not. */
export function retire(budget: Budget, now: Date): Budget {
  return { ...budget, enabled: false, updatedAt: now };
}

/**
 * The listing order, transcribed exactly: subject, then period, then id.
 *
 * The final id comparison is what makes the order TOTAL. Two caps written in the
 * same millisecond would otherwise come back in whatever order the store felt
 * like, and a paged listing whose order is not total silently drops and repeats
 * rows across pages.
 */
export function byListingOrder(left: Budget, right: Budget): number {
  if (left.target.subject !== right.target.subject) {
    return left.target.subject < right.target.subject ? -1 : 1;
  }
  if (left.period !== right.period) return left.period < right.period ? -1 : 1;
  if (left.budgetId === right.budgetId) return 0;
  return left.budgetId < right.budgetId ? -1 : 1;
}
