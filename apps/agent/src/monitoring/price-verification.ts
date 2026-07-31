/**
 * Price verification — the decision logic for the daily price-verify task.
 *
 * The task's job: take the upstream catalog (broad but wrong on individual
 * rows), read each in-use model's price off the PROVIDER's own pricing page,
 * and decide whether to accept that reading as a verified override.
 *
 * The hard part is not reading the page — it is deciding when NOT to trust the
 * reading. An LLM extracting numbers from a pricing table can misread a row,
 * pick up the Batch column instead of Standard, or hallucinate a plausible
 * figure, in exactly the same way a stale catalog can be wrong. If we auto-apply
 * whatever comes back, we have swapped one silent error source for another with
 * more moving parts.
 *
 * So the policy is FAIL CLOSED: a reading is accepted only when it is
 * corroborated and unsurprising. Anything else is held for a human, and the
 * previous known-good value stays in force. A held row is visible; a wrong row
 * is not.
 *
 * Pure and dependency-free so the policy is unit-testable without network,
 * an LLM, or Trigger.
 */

/** USD per token, matching the catalog's units. */
export interface PriceReading {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type VerificationStatus =
  | "accepted" // corroborated, sane, safe to write
  | "unchanged" // matches what we already trust; nothing to do
  | "held" // suspicious — keep the old value, surface for review
  | "no-reading"; // extraction failed or was incomplete

export interface Verdict {
  model: string;
  status: VerificationStatus;
  reason: string;
  proposed?: PriceReading;
  /** What the upstream catalog claims, for the discrepancy log. */
  catalog?: PriceReading;
  /** Ratio vs the currently-trusted input price, when a move was detected. */
  moveFactor?: number;
}

/** Two independent readings must agree within this relative tolerance. */
const AGREEMENT_TOLERANCE = 0.001;
/** A move larger than this vs the currently-trusted price is held for review. */
const MAX_UNREVIEWED_MOVE = 2;

/**
 * Plausibility envelopes, derived from how providers actually price rather than
 * from theory. A reading outside these is far more likely to be a misread column
 * than a real price:
 *   - cache reads run 0.02x-0.5x of input across Anthropic, OpenAI and Google.
 *   - cache writes run 1.0x-2.5x (Anthropic 1.25x, OpenAI gpt-5.6-luna 2.5x).
 *     Note the ceiling is deliberately above 1.0 — writes costing MORE than
 *     fresh input is real, not a bug, and an envelope that assumed otherwise
 *     would reject the true value.
 *   - output runs 2x-20x input.
 */
const ENVELOPES = {
  cacheReadRatio: { min: 0.01, max: 0.6 },
  cacheWriteRatio: { min: 0.5, max: 3.0 },
  outputRatio: { min: 0.5, max: 25 },
} as const;

const near = (a: number, b: number, tol = AGREEMENT_TOLERANCE): boolean => {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? true : Math.abs(a - b) / scale <= tol;
};

/**
 * Require two independent readings to agree before either is usable.
 *
 * One LLM read of a pricing page is a single point of failure with no error
 * signal — it returns a confident number whether or not it read the right row.
 * Two independent reads disagreeing is the only cheap evidence we get that the
 * page was ambiguous or the extraction was unstable.
 */
export function reconcileReadings(
  a: PriceReading | null | undefined,
  b: PriceReading | null | undefined,
): { agreed: PriceReading | null; disagreements: string[] } {
  if (!a || !b) return { agreed: null, disagreements: ["missing one of two readings"] };
  const fields: (keyof PriceReading)[] = ["input", "output", "cacheRead", "cacheWrite"];
  const agreed: PriceReading = {};
  const disagreements: string[] = [];
  for (const f of fields) {
    const av = a[f];
    const bv = b[f];
    if (av === undefined && bv === undefined) continue;
    if (av === undefined || bv === undefined) {
      // One read found a field the other did not. Not a contradiction, but not
      // corroborated either — drop it rather than take the single reading.
      disagreements.push(`${f}: only one reading produced a value`);
      continue;
    }
    if (!near(av, bv)) {
      disagreements.push(`${f}: ${av} vs ${bv}`);
      continue;
    }
    agreed[f] = av;
  }
  return { agreed: Object.keys(agreed).length > 0 ? agreed : null, disagreements };
}

/**
 * Decide what to do with a corroborated reading.
 *
 * `trusted` is the currently-authoritative price (an existing verified override
 * if we have one, else the catalog row). Moves are measured against it.
 */
export function assessReading(
  model: string,
  agreed: PriceReading | null,
  trusted: PriceReading | undefined,
  catalog: PriceReading | undefined,
  disagreements: string[] = [],
): Verdict {
  if (!agreed) {
    return {
      model,
      status: "no-reading",
      reason: disagreements.length
        ? `readings did not corroborate — ${disagreements.join("; ")}`
        : "no usable reading extracted",
      catalog,
    };
  }
  // A price with no input rate cannot be used for anything; every other field is
  // interpreted relative to it.
  if (agreed.input === undefined || !(agreed.input > 0)) {
    return { model, status: "no-reading", reason: "no input price in reading", catalog };
  }

  // Envelope checks — catch a misread column before it reaches billing.
  const ratioChecks: Array<[keyof PriceReading, { min: number; max: number }, string]> = [
    ["cacheRead", ENVELOPES.cacheReadRatio, "cache-read"],
    ["cacheWrite", ENVELOPES.cacheWriteRatio, "cache-write"],
    ["output", ENVELOPES.outputRatio, "output"],
  ];
  for (const [field, env, label] of ratioChecks) {
    const v = agreed[field];
    if (v === undefined) continue;
    const ratio = v / agreed.input;
    if (ratio < env.min || ratio > env.max) {
      return {
        model,
        status: "held",
        reason: `${label} ratio ${ratio.toFixed(3)}x input is outside the plausible ${env.min}-${env.max}x band — likely a misread column`,
        proposed: agreed,
        catalog,
      };
    }
  }

  // Nothing trusted yet — accept, since the alternative is the catalog we
  // already know can be wrong.
  if (!trusted || trusted.input === undefined || !(trusted.input > 0)) {
    return { model, status: "accepted", reason: "no prior trusted price", proposed: agreed, catalog };
  }

  const moveFactor = agreed.input / trusted.input;
  if (moveFactor > MAX_UNREVIEWED_MOVE || moveFactor < 1 / MAX_UNREVIEWED_MOVE) {
    return {
      model,
      status: "held",
      reason: `input price moved ${moveFactor.toFixed(2)}x vs the trusted value — too large to apply unreviewed`,
      proposed: agreed,
      catalog,
      moveFactor,
    };
  }

  const same =
    near(agreed.input, trusted.input, 0.005) &&
    (agreed.output === undefined ||
      trusted.output === undefined ||
      near(agreed.output, trusted.output, 0.005)) &&
    (agreed.cacheRead === undefined ||
      trusted.cacheRead === undefined ||
      near(agreed.cacheRead, trusted.cacheRead, 0.005));
  if (same) {
    return { model, status: "unchanged", reason: "matches the trusted price", proposed: agreed, catalog };
  }

  return { model, status: "accepted", reason: "corroborated and within tolerance", proposed: agreed, catalog, moveFactor };
}

/**
 * Flag rows where the catalog disagrees with the verified price, so the
 * discrepancy is logged rather than silently patched. This is what would have
 * caught gpt-5.6-luna: a 5x gap on one row while its sibling was exact.
 */
export function catalogDiscrepancy(
  verified: PriceReading,
  catalog: PriceReading | undefined,
): { field: keyof PriceReading; verified: number; catalog: number; factor: number }[] {
  if (!catalog) return [];
  const out: { field: keyof PriceReading; verified: number; catalog: number; factor: number }[] = [];
  for (const f of ["input", "output", "cacheRead", "cacheWrite"] as (keyof PriceReading)[]) {
    const v = verified[f];
    const c = catalog[f];
    if (v === undefined || c === undefined || v === 0) continue;
    if (!near(v, c, 0.02)) out.push({ field: f, verified: v, catalog: c, factor: c / v });
  }
  return out;
}
