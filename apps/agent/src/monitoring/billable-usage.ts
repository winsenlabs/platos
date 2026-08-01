/**
 * ONE SOURCE OF TRUTH for what a turn cost and what counts as work done.
 *
 * THE PROBLEM
 *
 * Cost was recorded twice on every turn and read inconsistently everywhere:
 *
 *   cost_cents             prices FRESH input + output only. Cache reads and
 *                          cache writes are invisible to it.
 *   cost_with_cache_cents  prices everything actually billed.
 *
 * Almost every consumer read the first one — traces, utilization, the
 * conversation UI, the reconcile task, and (worst) budget enforcement. Measured
 * on the live deployment for 2026-07-31: cost_with_cache 25.70c vs cost_cents
 * 2.47c. A 10x understatement, and budgets were being enforced against the
 * small number, so a limit could not trip when it should.
 *
 * The gap WIDENS as caching improves. Before prompt caching landed most tokens
 * were fresh and the two figures were ~9% apart; at 90%+ cache-read they differ
 * by an order of magnitude. Fixing caching made the reporting worse, which is
 * the sort of thing that stays hidden until someone reads a bill.
 *
 * THE RULE
 *
 * `PlatosAgentMessage.responseJson` on the assistant row is authoritative.
 * Everything else — Redis rollups, dashboards, budgets, traces — DERIVES from
 * it through the helpers here. Nothing reads a cost field directly.
 *
 * WHAT COUNTS AS A "TASK"
 *
 * A task is a JOB THE AGENT DID: one completed turn, one thing the user asked
 * for. It is NOT a tool call. An agent that searched five times and executed
 * twice to answer one question did ONE task, not seven — the other six are its
 * own deliberation and billing the user for them is billing them for the
 * agent's indecision. Tool calls remain visible as a diagnostic (they are how
 * you spot thrash) but they are not a unit of work.
 *
 * Pure and dependency-free so the arithmetic is testable without Nest or a DB.
 */

/** The shape `responseJson` carries on an assistant message row. */
export interface TurnRecord {
  cost_cents?: number | null;
  cost_with_cache_cents?: number | null;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadInputTokens?: number | null;
    cacheCreationInputTokens?: number | null;
    reasoningTokens?: number | null;
  } | null;
}

/**
 * The billable cost of a turn, in cents.
 *
 * Prefers `cost_with_cache_cents`. Falls back to `cost_cents` ONLY for rows
 * written before cache telemetry existed — detectable because they carry no
 * cache counters at all. A row that HAS cache counters but a zero
 * cost_with_cache is genuinely zero, not missing, so it must not fall back.
 */
export function billableCostCents(rj: TurnRecord | null | undefined): number {
  if (!rj) return 0;
  const withCache = rj.cost_with_cache_cents;
  if (typeof withCache === "number" && Number.isFinite(withCache)) return withCache;
  const naive = rj.cost_cents;
  return typeof naive === "number" && Number.isFinite(naive) ? naive : 0;
}

/**
 * Whether this row represents one unit of work done for the user.
 *
 * An assistant row IS the completed turn, so it counts once. Rows with no usage
 * at all (a dispatch stub, an errored turn that never reached the model) did no
 * work and must not be counted — otherwise a failing agent inflates the number
 * it is judged by.
 */
export function isCompletedTask(rj: TurnRecord | null | undefined): boolean {
  if (!rj) return false;
  const u = rj.usage;
  if (!u) return false;
  const inTok = Number(u.inputTokens ?? 0);
  const outTok = Number(u.outputTokens ?? 0);
  return inTok > 0 || outTok > 0;
}

/** Total tokens actually sent, cache included. Used for rate/efficiency views. */
export function totalInputTokens(rj: TurnRecord | null | undefined): number {
  const u = rj?.usage;
  if (!u) return 0;
  // `inputTokens` is INCLUSIVE of the cache slice (see CostService), so it is
  // already the total — adding the cache counters would double-count.
  return Number(u.inputTokens ?? 0);
}

/**
 * Aggregate a set of turns into the numbers every surface should show.
 *
 * One function, so a dashboard, a budget check and an invoice cannot disagree
 * about the same window. That divergence is exactly what produced a usage page,
 * a trace view and a budget that each reported a different figure for one day.
 */
export function summarise(rows: Array<TurnRecord | null | undefined>): {
  tasks: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
} {
  let tasks = 0, costCents = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0;
  for (const rj of rows) {
    if (!rj) continue;
    if (isCompletedTask(rj)) tasks++;
    costCents += billableCostCents(rj);
    inputTokens += totalInputTokens(rj);
    outputTokens += Number(rj.usage?.outputTokens ?? 0);
    cacheReadTokens += Number(rj.usage?.cacheReadInputTokens ?? 0);
  }
  // Round once, at the end, at 0.0001c — rounding per row loses sub-cent turns
  // entirely, and cheap models produce a lot of those.
  return {
    tasks,
    costCents: Math.round(costCents * 10_000) / 10_000,
    inputTokens,
    outputTokens,
    cacheReadTokens,
  };
}
