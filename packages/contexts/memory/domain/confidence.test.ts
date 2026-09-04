import { describe, expect, it } from "vitest";

import {
  boundedConfidence,
  FEEDBACK_STEP,
  isUsableRevision,
  NEUTRAL_CONFIDENCE,
  reconcileConfidence,
  standingFor,
  tallyRatings,
} from "./confidence.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const EARLIER = new Date("2026-09-01T09:00:00.000Z");

describe("boundedConfidence", () => {
  it("clamps to [0, 1]", () => {
    expect(boundedConfidence(-3)).toBe(0);
    expect(boundedConfidence(0.4)).toBe(0.4);
    expect(boundedConfidence(9)).toBe(1);
  });

  it("treats a NON-FINITE value as neutral rather than sorting unpredictably", () => {
    expect(boundedConfidence(Number.NaN)).toBe(NEUTRAL_CONFIDENCE);
    expect(boundedConfidence(Number.POSITIVE_INFINITY)).toBe(NEUTRAL_CONFIDENCE);
    expect(boundedConfidence(Number.NEGATIVE_INFINITY)).toBe(NEUTRAL_CONFIDENCE);
  });
});

describe("tallyRatings", () => {
  it("counts +1 and -1 and nothing else", () => {
    expect(tallyRatings([1, 1, -1, 0, 5, -1])).toEqual({ positives: 2, negatives: 2 });
  });

  it("an empty list is a zero tally", () => {
    expect(tallyRatings([])).toEqual({ positives: 0, negatives: 0 });
  });
});

describe("reconcileConfidence — recomputed, never accumulated", () => {
  it("captures the baseline from `confidence` on the FIRST reconciliation", () => {
    const reconciled = reconcileConfidence(
      { confidence: 0.7, feedbackBaselineConfidence: null, quarantinedAt: null },
      { positives: 1, negatives: 0 },
      NOW,
    );
    expect(reconciled.baseline).toBe(0.7);
    expect(reconciled.confidence).toBeCloseTo(0.8, 10);
  });

  it("uses the CAPTURED baseline on later reconciliations, so nothing compounds", () => {
    const state = { confidence: 0.8, feedbackBaselineConfidence: 0.7, quarantinedAt: null };
    const again = reconcileConfidence(state, { positives: 1, negatives: 0 }, NOW);
    expect(again.baseline).toBe(0.7);
    expect(again.confidence).toBeCloseTo(0.8, 10);
  });

  it("is IDEMPOTENT over the same ratings", () => {
    const first = reconcileConfidence(
      { confidence: 0.5, feedbackBaselineConfidence: null, quarantinedAt: null },
      { positives: 2, negatives: 0 },
      NOW,
    );
    const second = reconcileConfidence(
      {
        confidence: first.confidence,
        feedbackBaselineConfidence: first.baseline,
        quarantinedAt: first.quarantinedAt,
      },
      { positives: 2, negatives: 0 },
      NOW,
    );
    expect(second).toEqual(first);
  });

  it("falls back to neutral when the extractor stated nothing", () => {
    const reconciled = reconcileConfidence(
      { confidence: null, feedbackBaselineConfidence: null, quarantinedAt: null },
      { positives: 0, negatives: 0 },
      NOW,
    );
    expect(reconciled.baseline).toBe(NEUTRAL_CONFIDENCE);
    expect(reconciled.confidence).toBe(NEUTRAL_CONFIDENCE);
  });

  it("moves by exactly one step per net thumb", () => {
    const reconciled = reconcileConfidence(
      { confidence: 0.5, feedbackBaselineConfidence: null, quarantinedAt: null },
      { positives: 3, negatives: 1 },
      NOW,
    );
    expect(reconciled.confidence).toBeCloseTo(0.5 + 2 * FEEDBACK_STEP, 10);
  });

  it("clamps the result rather than letting ten thumbs run past 1", () => {
    const reconciled = reconcileConfidence(
      { confidence: 0.9, feedbackBaselineConfidence: null, quarantinedAt: null },
      { positives: 20, negatives: 0 },
      NOW,
    );
    expect(reconciled.confidence).toBe(1);
  });

  it("QUARANTINES while any current negative remains", () => {
    const reconciled = reconcileConfidence(
      { confidence: 0.8, feedbackBaselineConfidence: 0.8, quarantinedAt: null },
      { positives: 5, negatives: 1 },
      NOW,
    );
    expect(reconciled.quarantinedAt).toBe(NOW);
  });

  it("PRESERVES the original quarantine instant across reconciliations", () => {
    const reconciled = reconcileConfidence(
      { confidence: 0.8, feedbackBaselineConfidence: 0.8, quarantinedAt: EARLIER },
      { positives: 0, negatives: 2 },
      NOW,
    );
    expect(reconciled.quarantinedAt).toBe(EARLIER);
  });

  it("CLEARS the quarantine when the last negative goes", () => {
    const reconciled = reconcileConfidence(
      { confidence: 0.4, feedbackBaselineConfidence: 0.5, quarantinedAt: EARLIER },
      { positives: 1, negatives: 0 },
      NOW,
    );
    expect(reconciled.quarantinedAt).toBeNull();
    expect(reconciled.confidence).toBeCloseTo(0.6, 10);
  });

  it("a positive majority does NOT lift a quarantine while a negative stands", () => {
    const reconciled = reconcileConfidence(
      { confidence: 0.5, feedbackBaselineConfidence: 0.5, quarantinedAt: null },
      { positives: 9, negatives: 1 },
      NOW,
    );
    expect(reconciled.quarantinedAt).toBe(NOW);
  });
});

describe("standingFor", () => {
  it("is `applied` when the revision is the one this work was scheduled against", () => {
    expect(standingFor(4, 4)).toBe("applied");
  });

  it("is `stale` when a later upsert already won", () => {
    expect(standingFor(5, 4)).toBe("stale");
  });

  it("is `stale` rather than applied when the stored revision is OLDER", () => {
    expect(standingFor(3, 4)).toBe("stale");
  });

  it("is `missing` when the rating no longer exists", () => {
    expect(standingFor(null, 4)).toBe("missing");
  });
});

describe("isUsableRevision", () => {
  it("requires a positive whole number", () => {
    expect(isUsableRevision(1)).toBe(true);
    expect(isUsableRevision(0)).toBe(false);
    expect(isUsableRevision(-1)).toBe(false);
    expect(isUsableRevision(1.5)).toBe(false);
    expect(isUsableRevision(Number.NaN)).toBe(false);
  });
});
