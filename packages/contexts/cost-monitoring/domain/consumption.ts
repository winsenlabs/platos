// One principal's standing across every cap that applies to them.
//
// The operator-facing question this answers is "why is this user being stopped",
// and it is a different question from the one the guard answers. The guard picks
// ONE cap and refuses; this shows every cap the user is inside, including the
// ones that are nowhere near their limit, because an operator debugging a
// throttle needs to see the cap they did NOT hit as much as the one they did.
//
// WHICH CAPS ARE IN SCOPE FOR A USER, transcribed from the source:
//
//   environment-wide caps  — every user inherits them, so they are shown even
//                            though they are not about this user. Leaving them
//                            out is how an operator concludes a user has no cap
//                            and then cannot explain the refusal.
//   the wildcard user cap  — the default allowance, evaluated against THIS
//                            user's own counters.
//   this user's own cap    — if one exists.
//   agent caps             — shown, because a user working through a capped
//                            agent is stopped by it.
//
// AND WHICH ARE NOT: a `skill`-tier cap that names a skill. There can be dozens,
// they are about a piece of behaviour rather than about this person, and a drawer
// that listed them would bury the four rows that explain the refusal. A
// skill-tier cap with NO skill filter is environment-wide in effect and is shown.
//
// FAIL-GRACEFUL, PER CAP. A counter read that fails drops that one cap from the
// answer and leaves the rest. The source does this, and it is right: a partial
// answer is useful, and an operator can tell a missing row from a wrong one.

import type { Budget } from "./budget.js";
import type { BudgetStatus } from "./budget-status.js";
import { EVERY_USER } from "./budget-scope.js";

/** Does this cap belong in a user's consumption drawer? */
export function concernsUser(budget: Budget, userId: string): boolean {
  if (!budget.enabled) return false;
  if (budget.target.tier !== "llm" && budget.target.skillSlug !== null) return false;
  if (budget.target.subject === "user") {
    return budget.target.targetId === EVERY_USER || budget.target.targetId === userId;
  }
  return budget.target.subject === "scope" || budget.target.subject === "agent";
}

/**
 * The context a cap's counters are read under, for one user.
 *
 * An agent cap is read against the AGENT's counters, with the user carried along
 * so a per-user sub-read still has one. An environment-wide or user cap is read
 * against the user. Getting this backwards charges the whole environment's spend
 * to one person's drawer, which is the sort of number that gets someone
 * suspended.
 */
export function readingContextFor(
  budget: Budget,
  userId: string,
): { readonly agentId?: string; readonly userId: string } {
  if (budget.target.subject === "agent") {
    return { agentId: budget.target.targetId, userId };
  }
  return { userId };
}

/** One principal's whole picture. */
export interface ConsumptionSummary {
  readonly userId: string;
  readonly blocked: boolean;
  readonly reason: string | null;
  readonly caps: readonly BudgetStatus[];
  readonly rateLimit: RateLimitReading | null;
  readonly rateLimited: boolean;
  readonly fetchedAt: Date;
}

/**
 * The live request counters, folded in beside the spend caps.
 *
 * `identity-access` owns per-principal rate-limit buckets (ADR M0.3 §1 row 1),
 * and this context has no allow-list edge to it. So the reading arrives as
 * DATA — the composition root reads it and passes it in — rather than through an
 * import. Nothing here computes a rate limit; it decides only whether the
 * numbers it was handed have reached the ceilings it was handed with them.
 */
export interface RateLimitReading {
  readonly minute: number;
  readonly hour: number;
  readonly day: number;
  readonly perMinute: number | null;
  readonly perHour: number | null;
  readonly perDay: number | null;
}

/**
 * Is any rate ceiling reached?
 *
 * A null ceiling is NOT a ceiling of zero. The source reads the ceilings off an
 * optional collaborator and treats a missing one as "not limited"; expressing
 * that as `null` rather than `0` is what stops an unset ceiling from reading as
 * "limited at zero requests", which would mark every principal rate-limited.
 */
export function isRateLimited(reading: RateLimitReading | null): boolean {
  if (reading === null) return false;
  const reached = (count: number, ceiling: number | null): boolean =>
    ceiling !== null && ceiling > 0 && count >= ceiling;
  return (
    reached(reading.minute, reading.perMinute) ||
    reached(reading.hour, reading.perHour) ||
    reached(reading.day, reading.perDay)
  );
}

/** Every (cap, user) pair at or past its cap. */
export interface BreachedCap {
  readonly userId: string;
  readonly budgetId: string;
  readonly percentBasisPoints: number;
  readonly period: string;
}

/**
 * The users a cap must be evaluated against when sweeping for breaches.
 *
 * A wildcard user cap fans out across every active user; a named user cap is one
 * user; an environment or agent cap is a single composite row under `*`, because
 * it is breached for everyone at once and listing it per user would report one
 * breach as a hundred.
 */
export function sweepSubjects(budget: Budget, activeUserIds: readonly string[]): readonly string[] {
  if (budget.target.subject !== "user") return [EVERY_USER];
  return budget.target.targetId === EVERY_USER ? activeUserIds : [budget.target.targetId];
}
