/**
 * ONE SOURCE OF TRUTH for usage, cost and billing.
 *
 * THE INCIDENT
 *
 * A usage page reported "Walle ran 322 tasks this week." It had not. The number
 * counted tool calls, so an agent that searched, read three documents and
 * replied was billed as five tasks instead of one. Usage, billing and the
 * underlying rows all disagreed, and each was arithmetically defensible on its
 * own terms — which is why nobody caught it. Twelve surfaces each re-derived
 * "cost for this period" from a slightly different field.
 *
 * THE RULE
 *
 * A TASK IS ONE COMPLETED TURN. Not a model call, not a tool call, not a
 * message. An agent that searches, reads three documents and replies has done
 * ONE task while writing one Turn row, several Step rows and six Tool Call
 * rows. Steps and Tool Calls are diagnostics — they are how you spot thrash —
 * and they never increment the billable-unit count.
 *
 * COST IS CACHE-AWARE, ALWAYS.
 *
 * Two cost fields exist on the rollups for historical reasons:
 *
 *   cost_cents             once meant FRESH input + output only. Cache reads
 *                          and cache writes were invisible to it.
 *   cost_with_cache_cents  prices everything actually billed.
 *
 * Almost every consumer read the first — traces, utilization, the reconcile
 * task, and worst of all budget enforcement. Measured on the live deployment
 * for 2026-07-31: cost_with_cache 25.70c against cost_cents 2.47c. A 10x
 * understatement, and a cap enforced against the small number cannot trip. The
 * gap WIDENS as caching improves, so fixing prompt caching quietly disabled
 * budgets — the sort of thing that stays hidden until someone reads a bill.
 *
 * Since WIN-125 both fields are written from the same four-rate canonical
 * calculation, so new rows agree by construction. {@link billableCostCents}
 * still prefers `cost_with_cache_cents` because rows written before that are
 * still inside the 90-day rollup TTL, and for those the preference is the
 * difference between the right number and a tenth of it.
 *
 * TOKEN LANES
 *
 * `inputTokens` is INCLUSIVE of the cache slice. Adding the cache counters back
 * double-counts. The only legitimate subtraction is
 * {@link freshInputTokens}, and it lives here precisely once: it was being
 * computed in three places against three different bases, which is how one turn
 * came to report "no-cache tokens 3" on one panel and "9" on another.
 *
 * SPEND LANES
 *
 * Spend splits into `inference` (agent turns and the model calls the runtime
 * makes on their behalf), `embedding`, `extraction`, `judge` and `skill`.
 * The four non-inference lanes are tagged at write time; `inference` is the
 * RESIDUAL. That is deliberate — a residual lane cannot disagree with the
 * headline total, whereas five independently-summed lanes can and eventually
 * will.
 *
 * Pure and dependency-free, so the arithmetic is testable without Nest, Redis
 * or a database. Every surface that reports usage imports from here and does no
 * arithmetic of its own.
 */

/** Which kind of work a cost belongs to. `inference` is the residual lane. */
export type UsageLane = "inference" | "embedding" | "extraction" | "judge" | "skill";

/** Every lane, in reporting order. `inference` first because it dominates. */
export const USAGE_LANES: readonly UsageLane[] = [
  "inference",
  "embedding",
  "extraction",
  "judge",
  "skill",
] as const;

/**
 * Rollup hash field names, shared by the Redis writers and every reader.
 *
 * These were string literals repeated across a writer and twelve readers, which
 * is how `cost_with_cache_cents` came to be written by one writer and read by
 * four of them.
 */
export const ROLLUP_FIELD = {
  costCents: "cost_cents",
  costWithCacheCents: "cost_with_cache_cents",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_input_tokens",
  cacheWriteTokens: "cache_creation_input_tokens",
  reasoningTokens: "reasoning_tokens",
  /**
   * One completed Turn. Written once per turn and by nothing else.
   *
   * `calls` — the field this used to be read from — counts MODEL calls, and
   * auxiliary work (embeddings, compaction, thread auto-naming) bumps it too.
   * Reading it as a task count is the "322 tasks" bug in its original form.
   * `runs`, written by the budget path, was always per-turn, so it is the one
   * legitimate fallback for rollups written before `tasks` existed.
   */
  tasks: "tasks",
  legacyTasks: "runs",
  /** Raw model-call counter. A diagnostic, never a billable unit. */
  calls: "calls",
} as const;

/**
 * The per-lane cost field a writer tags, keyed by lane.
 *
 * `inference` has no field of its own: it is whatever the total is not.
 */
const LANE_ROLLUP_FIELD: Readonly<Record<Exclude<UsageLane, "inference">, string>> = {
  embedding: "cost_cents:embedding",
  extraction: "cost_cents:extraction",
  judge: "cost_cents:eval-judge",
  skill: "cost_cents:tier:skill",
};

/**
 * The numbers every surface reports. One shape, so a dashboard, a budget check
 * and an invoice cannot describe the same window differently.
 */
export interface UsageTotals {
  /** Completed Turns. The billable unit. */
  tasks: number;
  /** Cache-aware cost — the number that matches the provider bill. */
  costCents: number;
  /** Everything sent to the model, cache slice INCLUDED. */
  inputTokens: number;
  /** Input tokens that were neither read from nor written to cache. */
  freshInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** A window's totals plus the lane split that must sum back to `costCents`. */
export interface UsageWindow extends UsageTotals {
  byLane: Record<UsageLane, number>;
}

export const EMPTY_USAGE: Readonly<UsageTotals> = Object.freeze({
  tasks: 0,
  costCents: 0,
  inputTokens: 0,
  freshInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

/** Anything carrying the two historical cost fields: a rollup, a turn record. */
export interface BillableCostRecord {
  cost_cents?: number | null;
  cost_with_cache_cents?: number | null;
}

/** A Postgres Step row, as far as the arithmetic is concerned. */
export interface StepUsageRow {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  reasoningTokens?: number | null;
  /** Prisma Decimal, number or null — Step.costCents is the priced figure. */
  costCents?: unknown;
}

/** A Postgres Turn row plus its Steps. One row, one task. */
export interface TurnUsageRow {
  status?: string | null;
  /** Prisma Decimal, number or null. Authoritative when present. */
  costCents?: unknown;
  steps?: StepUsageRow[] | null;
}

/**
 * The billable cost of a record, in cents.
 *
 * Prefers `cost_with_cache_cents`. Falls back to `cost_cents` ONLY for rows
 * written before cache telemetry existed — detectable because they carry no
 * cache-adjusted figure at all. A row that HAS one and it is zero is genuinely
 * zero, not missing, so it must not fall back: a real turn recorded
 * cost_cents 0 against cost_with_cache 0.6861, and falling back on falsy would
 * resurrect the wrong number.
 */
export function billableCostCents(record: BillableCostRecord | null | undefined): number {
  if (!record) return 0;
  const withCache = record.cost_with_cache_cents;
  if (typeof withCache === "number" && Number.isFinite(withCache)) return withCache;
  const naive = record.cost_cents;
  return typeof naive === "number" && Number.isFinite(naive) ? naive : 0;
}

/** A Redis hash as ioredis returns it — every value a string, or absent. */
export type RollupHash = Record<string, string | undefined>;

function num(hash: RollupHash, field: string): number {
  const raw = hash[field];
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function int(hash: RollupHash, field: string): number {
  return Math.trunc(num(hash, field));
}

/**
 * The billable cost of a Redis rollup hash — {@link billableCostCents} over the
 * string-valued fields Redis actually stores.
 *
 * Budget enforcement reads through here. It previously parsed `cost_cents`
 * directly, which is the 10x understatement above.
 */
export function billableCostFromRollup(hash: RollupHash | null | undefined): number {
  if (!hash) return 0;
  const withCache = hash[ROLLUP_FIELD.costWithCacheCents];
  if (withCache !== undefined && withCache !== "") {
    const parsed = Number(withCache);
    if (Number.isFinite(parsed)) return parsed;
  }
  return num(hash, ROLLUP_FIELD.costCents);
}

/**
 * Input tokens that were neither served from cache nor written to it.
 *
 * THE ONLY subtraction of the cache lanes anywhere. Clamped at zero: providers
 * occasionally report a cache slice marginally larger than the input total, and
 * a negative token count on a dashboard is worse than a zero.
 */
export function freshInputTokens(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  return Math.max(0, (inputTokens || 0) - (cacheReadTokens || 0) - (cacheWriteTokens || 0));
}

/**
 * The token-details blobs a turn-level usage event carries.
 *
 * The streaming runtime accumulates cache and reasoning counters across every
 * Step of a turn, and used to emit those accumulators beside the LAST step's
 * raw `inputTokenDetails` blob — so one usage record reported cache reads of
 * 39,795 and 14,788 simultaneously. Projecting the blobs from the accumulators
 * makes the two the same numbers said twice. `undefined` rather than a zeroed
 * blob when a lane never fired, so a non-caching provider stays silent instead
 * of asserting a zero it did not measure.
 */
export function turnTokenDetails(totals: {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}): {
  inputTokenDetails?: { cacheReadTokens: number; cacheWriteTokens: number };
  outputTokenDetails?: { reasoningTokens: number };
} {
  const cacheReadTokens = Math.max(0, totals.cacheReadTokens || 0);
  const cacheWriteTokens = Math.max(0, totals.cacheWriteTokens || 0);
  const reasoningTokens = Math.max(0, totals.reasoningTokens || 0);
  return {
    ...(cacheReadTokens > 0 || cacheWriteTokens > 0
      ? { inputTokenDetails: { cacheReadTokens, cacheWriteTokens } }
      : {}),
    ...(reasoningTokens > 0 ? { outputTokenDetails: { reasoningTokens } } : {}),
  };
}

/** Full totals from one Redis rollup hash. `tasks` reads either writer's field. */
export function usageFromRollup(hash: RollupHash | null | undefined): UsageTotals {
  if (!hash) return { ...EMPTY_USAGE };
  const inputTokens = int(hash, ROLLUP_FIELD.inputTokens);
  const cacheReadTokens = int(hash, ROLLUP_FIELD.cacheReadTokens);
  const cacheWriteTokens = int(hash, ROLLUP_FIELD.cacheWriteTokens);
  return {
    tasks: int(hash, ROLLUP_FIELD.tasks) || int(hash, ROLLUP_FIELD.legacyTasks),
    costCents: billableCostFromRollup(hash),
    inputTokens,
    freshInputTokens: freshInputTokens(inputTokens, cacheReadTokens, cacheWriteTokens),
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: int(hash, ROLLUP_FIELD.outputTokens),
    reasoningTokens: int(hash, ROLLUP_FIELD.reasoningTokens),
  };
}

/**
 * The per-lane split of one rollup hash.
 *
 * The four tagged lanes are read from their own fields; `inference` is what the
 * billable total is not. Clamped at zero so a partially-expired hash — tagged
 * lanes surviving a total that has already been trimmed — reports a small
 * inference lane rather than a negative one.
 */
export function laneCostsFromRollup(
  hash: RollupHash | null | undefined,
): Record<UsageLane, number> {
  const total = billableCostFromRollup(hash);
  const lanes: Record<UsageLane, number> = {
    inference: 0,
    embedding: 0,
    extraction: 0,
    judge: 0,
    skill: 0,
  };
  if (!hash) return lanes;
  let tagged = 0;
  for (const [lane, field] of Object.entries(LANE_ROLLUP_FIELD) as Array<
    [Exclude<UsageLane, "inference">, string]
  >) {
    const value = num(hash, field);
    lanes[lane] = value;
    tagged += value;
  }
  lanes.inference = Math.max(0, total - tagged);
  return lanes;
}

/**
 * The lane an auxiliary cost belongs to.
 *
 * `CostService.recordAuxiliaryCost` accepts an open-ended `kind`, and the
 * runtime uses it for compaction, thread auto-naming, route preflight and
 * simulate-turn as well as the three named lanes. Those are all model calls
 * made on a turn's behalf, so they belong in `inference` — which they reach by
 * being absent from the tagged fields rather than by being listed here.
 */
export function laneForAuxiliaryKind(kind: string): UsageLane {
  if (kind === "embedding") return "embedding";
  if (kind === "extraction") return "extraction";
  if (kind === "eval-judge") return "judge";
  if (kind === "skill" || kind === "tier:skill") return "skill";
  return "inference";
}

/** The rollup field a lane's cost is tagged under, or null for the residual. */
export function laneRollupField(lane: UsageLane): string | null {
  if (lane === "inference") return null;
  return LANE_ROLLUP_FIELD[lane];
}

function decimalToNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Totals from one Postgres Step row. A Step is never a task on its own. */
export function usageFromStep(step: StepUsageRow | null | undefined): UsageTotals {
  if (!step) return { ...EMPTY_USAGE };
  const inputTokens = Number(step.inputTokens ?? 0);
  const cacheReadTokens = Number(step.cacheReadInputTokens ?? 0);
  const cacheWriteTokens = Number(step.cacheCreationInputTokens ?? 0);
  return {
    tasks: 0,
    costCents: decimalToNumber(step.costCents),
    inputTokens,
    freshInputTokens: freshInputTokens(inputTokens, cacheReadTokens, cacheWriteTokens),
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: Number(step.outputTokens ?? 0),
    reasoningTokens: Number(step.reasoningTokens ?? 0),
  };
}

/**
 * Whether a Turn is one unit of work done for the user.
 *
 * A turn that never reached the model — a dispatch stub, a run that failed at
 * the gate — did no work and must not be counted, otherwise a failing agent
 * inflates the number it is judged by. Everything else counts exactly once,
 * however many Steps and Tool Calls it took.
 */
export function isCompletedTask(turn: TurnUsageRow | null | undefined): boolean {
  if (!turn) return false;
  if (turn.status != null && String(turn.status).toUpperCase() !== "SUCCEEDED") return false;
  const steps = turn.steps ?? [];
  for (const step of steps) {
    if (Number(step.inputTokens ?? 0) > 0 || Number(step.outputTokens ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Totals from one Postgres Turn and its Steps — the authoritative shape.
 *
 * Cost comes from `Turn.costCents` when present, because that is the figure the
 * turn was priced at; summing Steps is the fallback for turns written before a
 * turn-level cost existed. Tokens always sum the Steps: the Turn carries no
 * token columns of its own.
 */
export function usageFromTurn(turn: TurnUsageRow | null | undefined): UsageTotals {
  if (!turn) return { ...EMPTY_USAGE };
  let totals: UsageTotals = { ...EMPTY_USAGE };
  for (const step of turn.steps ?? []) totals = addUsage(totals, usageFromStep(step));
  if (turn.costCents !== null && turn.costCents !== undefined) {
    totals.costCents = decimalToNumber(turn.costCents);
  }
  totals.tasks = isCompletedTask(turn) ? 1 : 0;
  return totals;
}

/** Add two totals. Every rollup composes through here. */
export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    tasks: a.tasks + b.tasks,
    costCents: a.costCents + b.costCents,
    inputTokens: a.inputTokens + b.inputTokens,
    freshInputTokens: a.freshInputTokens + b.freshInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function sumUsage(rows: Iterable<UsageTotals>): UsageTotals {
  let totals: UsageTotals = { ...EMPTY_USAGE };
  for (const row of rows) totals = addUsage(totals, row);
  return totals;
}

/** Add two lane splits. */
export function addLanes(
  a: Record<UsageLane, number>,
  b: Record<UsageLane, number>,
): Record<UsageLane, number> {
  const out = {} as Record<UsageLane, number>;
  for (const lane of USAGE_LANES) out[lane] = (a[lane] ?? 0) + (b[lane] ?? 0);
  return out;
}

/**
 * Round cost ONCE, at the end, at 0.0001c.
 *
 * Rounding per row loses sub-cent turns entirely and cheap models produce a lot
 * of those — a thousand 0.0004c turns round to zero individually and to 0.4c
 * together. Token counts are integers and are left alone.
 */
export function roundUsage(totals: UsageTotals): UsageTotals {
  return { ...totals, costCents: roundCents(totals.costCents) };
}

export function roundCents(cents: number): number {
  return Math.round(cents * 10_000) / 10_000;
}

export function roundLanes(lanes: Record<UsageLane, number>): Record<UsageLane, number> {
  const out = {} as Record<UsageLane, number>;
  for (const lane of USAGE_LANES) out[lane] = roundCents(lanes[lane] ?? 0);
  return out;
}

/**
 * Aggregate Turns into the numbers every surface shows.
 *
 * The one function a usage page, a budget check and an invoice all call, so
 * they cannot disagree about a window. That divergence is exactly what produced
 * a usage page, a trace view and a budget each reporting a different figure for
 * the same day.
 */
export function summariseTurns(rows: Array<TurnUsageRow | null | undefined>): UsageTotals {
  let totals: UsageTotals = { ...EMPTY_USAGE };
  for (const row of rows) totals = addUsage(totals, usageFromTurn(row));
  return roundUsage(totals);
}
