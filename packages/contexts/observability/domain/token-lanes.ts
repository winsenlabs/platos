// Token lanes and what they cost.
//
// ONE FACT DECIDES THIS WHOLE FILE: `inputTokens` as a provider reports it is
// INCLUSIVE of the cached slice. So the lanes are a PARTITION of that total, not
// a set of independent counters, and `fresh = total - cacheRead - cacheWrite`.
//
// `fresh` is computed here and STORED rather than derived at read time. Three
// screens each deriving it from a different base is exactly how one label came
// to mean three different numbers, and the number that was billed has to be the
// number that is shown.
//
// RATES ARE FROZEN, NEVER LOOKED UP. Every rate below arrives on the observed
// event, having been the rate in force when the work ran. Nothing in this
// package consults a catalogue: re-pricing an old Turn with today's card
// silently rewrites an invoice that has already been issued.

import { decimal12, tokenCount } from "./column-values.js";

/** Token lanes as the provider reported them. `inputTokens` includes the cache slice. */
export interface ObservedTokens {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadInputTokens?: number | null;
  readonly cacheWriteInputTokens?: number | null;
  readonly reasoningTokens?: number | null;
}

/** The four rates that were in force when the work ran, in USD per token. */
export interface ObservedRates {
  readonly pricingSource?: string | null;
  /** The catalogue row id this cost is pinned to. */
  readonly pricingVersion?: string | null;
  readonly inputUsdPerToken?: number | null;
  readonly outputUsdPerToken?: number | null;
  readonly cacheReadUsdPerToken?: number | null;
  readonly cacheWriteUsdPerToken?: number | null;
}

export interface ResolvedLanes {
  readonly totalInput: number;
  readonly freshInput: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number;
}

/**
 * Split reported usage into the lanes the schema stores.
 *
 * Cache counters that exceed the reported input are CLAMPED, not trusted.
 * Providers do occasionally report a cache read larger than the input it was
 * part of, and letting `fresh` go negative would understate the bill by exactly
 * the amount of the error. Clamping in order — read first, then write against
 * what is left — keeps the four lanes a partition of `totalInput` under every
 * input, which is the invariant every aggregate over this table assumes.
 */
export function resolveLanes(tokens: ObservedTokens | undefined | null): ResolvedLanes {
  const totalInput = tokenCount(tokens?.inputTokens);
  const cacheRead = Math.min(totalInput, tokenCount(tokens?.cacheReadInputTokens));
  const cacheWrite = Math.min(totalInput - cacheRead, tokenCount(tokens?.cacheWriteInputTokens));
  return {
    totalInput,
    freshInput: Math.max(0, totalInput - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: tokenCount(tokens?.outputTokens),
    reasoning: tokenCount(tokens?.reasoningTokens),
  };
}

/** True when the three input lanes account for exactly the reported total. */
export function lanesPartitionInput(lanes: ResolvedLanes): boolean {
  return lanes.freshInput + lanes.cacheRead + lanes.cacheWrite === lanes.totalInput;
}

/** Per-lane extended cost in USD, as column text. */
export interface LaneCosts {
  readonly freshInput: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
  readonly output: string;
}

function rate(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Extend the resolved lanes at the frozen rates.
 *
 * A missing rate is zero, not "unknown": the columns are `Decimal DEFAULT 0` and
 * a null would make an aggregate over the lane silently skip the row rather than
 * report nothing was charged for it. The authoritative figure remains the one
 * the canonical store billed; these four are the EXPLANATION of it.
 */
export function laneCosts(lanes: ResolvedLanes, rates: ObservedRates | undefined | null): LaneCosts {
  return {
    freshInput: decimal12(lanes.freshInput * rate(rates?.inputUsdPerToken)),
    cacheRead: decimal12(lanes.cacheRead * rate(rates?.cacheReadUsdPerToken)),
    cacheWrite: decimal12(lanes.cacheWrite * rate(rates?.cacheWriteUsdPerToken)),
    output: decimal12(lanes.output * rate(rates?.outputUsdPerToken)),
  };
}
