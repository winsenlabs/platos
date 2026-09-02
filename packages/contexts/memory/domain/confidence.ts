// How feedback moves a memory's confidence, and when it withdraws it entirely.
//
// A `MessageRating` is a thumb on a TURN. A memory can be sourced from several
// turns, and a turn can source several memories, so confidence is not a running
// total that ratings increment — it is RECOMPUTED from the ratings that are
// current, every time. The source is explicit about why: "reconciles memory
// state from authoritative, current MessageRating rows", so a rating that was
// changed or deleted leaves no residue.
//
// THAT IS WHY `feedbackBaselineConfidence` EXISTS AND IS A SECOND COLUMN. The
// baseline is the confidence the extractor stated, before any thumb. Without it,
// a second reconciliation would compound on its own first result and three
// thumbs-up would saturate a memory that started at 0.5. The baseline is
// captured once, from whichever of the two columns is populated, and every
// later recomputation starts there.
//
// QUARANTINE IS A CONSEQUENCE, NOT A SETTING. Any current negative rating on any
// source turn withdraws the memory from recall, and the ORIGINAL instant is
// preserved while the negative remains — so "how long has this been withdrawn?"
// stays answerable across reconciliations. Removing the last negative clears it.
// No caller sets `quarantinedAt`; this function is the only thing that does.

/** The confidence a memory with nothing stated about it is treated as having. */
export const NEUTRAL_CONFIDENCE = 0.5;

/** What one thumb is worth. Ten consistent thumbs span the whole scale. */
export const FEEDBACK_STEP = 0.1;

/**
 * Clamp to [0, 1], and treat a non-finite value as neutral.
 *
 * The `NaN` case is not defensive padding: `confidence` is a nullable
 * `Float` column, an adapter reading it through a decimal type can yield `NaN`
 * for a malformed value, and a `NaN` confidence would order a memory
 * unpredictably against every other one rather than failing loudly.
 */
export function boundedConfidence(value: number): number {
  if (!Number.isFinite(value)) return NEUTRAL_CONFIDENCE;
  return Math.min(1, Math.max(0, value));
}

/** The current ratings on one memory's source turns, tallied. */
export interface FeedbackTally {
  readonly positives: number;
  readonly negatives: number;
}

/** A rating is +1 or -1; anything else is counted as neither. */
export function tallyRatings(ratings: readonly number[]): FeedbackTally {
  let positives = 0;
  let negatives = 0;
  for (const rating of ratings) {
    if (rating === 1) positives += 1;
    else if (rating === -1) negatives += 1;
  }
  return { positives, negatives };
}

/** What the reconciliation writes back. */
export interface ReconciledConfidence {
  readonly baseline: number;
  readonly confidence: number;
  readonly quarantinedAt: Date | null;
}

export interface ConfidenceState {
  readonly confidence: number | null;
  readonly feedbackBaselineConfidence: number | null;
  readonly quarantinedAt: Date | null;
}

/**
 * Recompute one memory's confidence from the ratings that are current.
 *
 * The baseline is taken from `feedbackBaselineConfidence` when it is already
 * captured, from `confidence` when this is the first reconciliation, and from
 * neutral when the extractor stated nothing. Capturing it is idempotent, which
 * is what makes running this twice over the same ratings a no-op.
 */
export function reconcileConfidence(
  state: ConfidenceState,
  tally: FeedbackTally,
  now: Date,
): ReconciledConfidence {
  const baseline = boundedConfidence(
    state.feedbackBaselineConfidence ?? state.confidence ?? NEUTRAL_CONFIDENCE,
  );
  const confidence = boundedConfidence(baseline + (tally.positives - tally.negatives) * FEEDBACK_STEP);
  return {
    baseline,
    confidence,
    quarantinedAt: tally.negatives > 0 ? (state.quarantinedAt ?? now) : null,
  };
}

/**
 * Whether a queued reconciliation is still the current one.
 *
 * `MessageRating` carries a monotonic `revision`, and a reconciliation is
 * scheduled against the revision that provoked it. A later upsert either wins
 * before this work runs — making it stale — or is scheduled after it, so the
 * last writer's revision is always the one that lands. Skipping a stale job is
 * how concurrent jobs stop finishing in arrival order rather than in revision
 * order.
 */
export type ReconciliationStanding = "applied" | "stale" | "missing";

export function standingFor(
  currentRevision: number | null,
  expectedRevision: number,
): ReconciliationStanding {
  if (currentRevision === null) return "missing";
  return currentRevision === expectedRevision ? "applied" : "stale";
}

/** A revision must be a positive whole number; the source refuses anything else. */
export function isUsableRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}
