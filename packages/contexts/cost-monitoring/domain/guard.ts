// The pre-spend ladder — which cap governs a spend that has not happened yet.
//
// `BudgetGuard` is named in ADR M0.3 §1 row 13 and §7 decision 3, and it answers
// one question: may this dispatch proceed, and if not, which cap said no. It is
// on the HOT PATH, so everything here is pure and takes the caps it was given.
//
// THE LADDER IS "MOST SPECIFIC WINS", AND — CRUCIALLY — "FIRST LEVEL WITH ANY
// MATCH WINS", NOT "FIRST LEVEL WITH A BLOCKING MATCH WINS".
//
//   1. this skill AND this agent
//   2. this skill, any agent
//   3. any skill, this agent
//   4. any skill, any agent
//
// The source stops at the first level that has ANY matching cap, whether or not
// that cap blocks. It does not cascade to the next level. That looks like a bug
// and is not: it is the difference between "the most specific cap governs" and
// "every cap governs and the strictest wins". Under the second reading, an
// operator who writes a generous per-agent exception cannot actually grant it,
// because the environment-wide cap they were trying to except from still
// applies. The first reading is the one an operator can reason about, and it is
// the one the source's own note commits to.
//
// The consequence is worth stating plainly, because a reader will otherwise
// think it is an oversight: a level-1 cap at 1% utilisation SILENCES a level-4
// cap that is at 300%. That is intended. The exception is the point.
//
// LEVELS 2 AND 3 ARE ASYMMETRIC, AND THAT IS ALSO THE SOURCE'S. A skill filter
// beats an agent filter, because a skill cap is written about a named piece of
// behaviour while an agent cap is written about a principal, and the narrower
// statement is the one about behaviour.
//
// TIER IS A FILTER, NOT A LEVEL. A caller asking about `skill` spend is never
// governed by an `llm` cap, at any level. Two separate ladders that never meet.

import { add, type Money } from "@platos/kernel";

import { overrideActive, type Budget } from "./budget.js";
import type { BudgetTier } from "./budget-scope.js";
import { isAtLimit } from "./spend.js";

/** What the caller is about to spend on. */
export interface SpendIntent {
  readonly tier: BudgetTier;
  readonly skillSlug: string | null;
  readonly agentId: string | null;
}

/** The cap that refused, as the caller reports it. */
export interface GuardRefusal {
  readonly budget: Budget;
  readonly label: string;
  readonly limitCents: number;
  readonly current: Money;
  readonly projected: Money;
}

export type GuardVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: GuardRefusal };

export const ALLOWED: GuardVerdict = Object.freeze({ allowed: true });

/**
 * The four rungs, most specific first.
 *
 * Each rung is total over the caps it is handed; a cap matches at most one rung,
 * because the four predicates partition on (has skill filter, has agent filter).
 */
export function ladderFor(intent: SpendIntent): readonly ((budget: Budget) => boolean)[] {
  const skillSlug = intent.skillSlug ?? null;
  const agentId = intent.agentId ?? null;
  return [
    (budget) =>
      skillSlug !== null &&
      agentId !== null &&
      budget.target.skillSlug === skillSlug &&
      budget.target.agentId === agentId,
    (budget) =>
      skillSlug !== null && budget.target.skillSlug === skillSlug && budget.target.agentId === null,
    (budget) =>
      agentId !== null && budget.target.skillSlug === null && budget.target.agentId === agentId,
    (budget) => budget.target.skillSlug === null && budget.target.agentId === null,
  ];
}

/** The caps that could possibly govern this intent: enabled, and this tier. */
export function candidates(budgets: readonly Budget[], intent: SpendIntent): readonly Budget[] {
  return budgets.filter((budget) => budget.enabled && budget.target.tier === intent.tier);
}

/**
 * The label an operator sees on a refusal — `skill skill=web-search day/5000c`.
 *
 * Built from the cap's own dimensions rather than from a stored name, because a
 * cap has no name column and inventing one would make two caps with the same
 * shape indistinguishable in a log.
 */
export function describeCap(budget: Budget): string {
  const parts: string[] = [budget.target.tier];
  if (budget.target.skillSlug !== null) parts.push(`skill=${budget.target.skillSlug}`);
  if (budget.target.agentId !== null) parts.push(`agent=${budget.target.agentId}`);
  parts.push(`${budget.period}/${budget.limitCents}c`);
  return parts.join(" ");
}

/** How much a cap has already used in its window, supplied by the caller. */
export type SpentLookup = (budget: Budget) => Money;

/**
 * Decide.
 *
 * `amount` is the spend about to happen, added to what the window already holds
 * before the comparison. Checking the CURRENT total instead would let a single
 * dispatch of any size through the moment before a cap was reached, which for a
 * skill that costs more than its own cap means the cap never stops anything.
 *
 * An overridden cap is skipped entirely — not evaluated and found to allow. It
 * still occupies its rung, so an override on the most specific cap suppresses
 * the whole ladder, which is what an operator granting an exception means.
 */
export function guard(
  budgets: readonly Budget[],
  intent: SpendIntent,
  amount: Money,
  spentIn: SpentLookup,
  at: Date,
): GuardVerdict {
  const pool = candidates(budgets, intent);
  for (const rung of ladderFor(intent)) {
    const matches = pool.filter(rung);
    if (matches.length === 0) continue;
    for (const budget of matches) {
      if (overrideActive(budget, at)) continue;
      const current = spentIn(budget);
      const projected = add(current, amount.microCents > 0n ? amount : { ...amount, microCents: 0n });
      if (isAtLimit(projected, budget.limitCents)) {
        return {
          allowed: false,
          refusal: {
            budget,
            label: describeCap(budget),
            limitCents: budget.limitCents,
            current,
            projected,
          },
        };
      }
    }
    // The most specific rung with any match has spoken. See the note above:
    // cascading from here would make an exception impossible to write.
    return ALLOWED;
  }
  return ALLOWED;
}
