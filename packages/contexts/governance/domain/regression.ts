// Did this version get worse?
//
// A regression report compares the candidate's mean score per criterion against
// a baseline version's, and says so per criterion. It is the one number a
// release decision is taken on, so all of it is pure.
//
// THE SOURCE'S REPORT CANNOT SAY "THE RUN DID NOT HAPPEN". It builds its
// per-criterion list from the CANDIDATE's rows alone, so a run in which every
// judge call failed produces an empty list, `regressed: false`, and a report
// that is indistinguishable from a clean pass. That is the worst possible
// failure for this particular artifact: it is read as permission to ship. Two
// things fix it here and both are in the returned value rather than in a log —
// a criterion the baseline scored and the candidate did not is reported with
// verdict `no-candidate`, and `complete` is false whenever any expected
// criterion produced no candidate sample.
//
// THE VERDICT IS TAKEN ON THE UNROUNDED DELTA. The source rounds each mean to
// two places for display and then compares the rounded numbers, so a delta of
// -4.996 displays as -5.00 and is called neutral, while the same report shows a
// number that reads as exactly the regression threshold. Here the comparison
// uses the exact means and the rounding is applied to the rendered fields only,
// so the verdict and the number a reader sees can still disagree in the last
// place — which is honest — but the verdict is never taken on a rounded value.

import { meanOf, roundToTwo } from "./eval-aggregate.js";
import type { AgentVersionId, EvalCriterionId } from "./identifiers.js";

export type RegressionVerdict = "regressed" | "neutral" | "improved" | "no-baseline" | "no-candidate";

/** One eval's score, as the comparison reads it. */
export interface RegressionSample {
  readonly criterionId: EvalCriterionId;
  readonly score: number;
}

export interface CriterionComparison {
  readonly criterionId: EvalCriterionId;
  readonly criterionName: string | null;
  /** Null when the baseline produced no samples for this criterion. */
  readonly baselineMean: number | null;
  /** Null when the candidate produced no samples for this criterion. */
  readonly candidateMean: number | null;
  readonly candidateSamples: number;
  readonly baselineSamples: number;
  /** `candidateMean - baselineMean`, rounded for display; 0 when either is null. */
  readonly delta: number;
  readonly verdict: RegressionVerdict;
}

export interface RegressionReport {
  readonly regressed: boolean;
  /**
   * False when a criterion the set asked for produced no candidate sample. A
   * report that is not complete has NOT cleared the version.
   */
  readonly complete: boolean;
  readonly baselineVersionId: AgentVersionId | null;
  readonly perCriterion: readonly CriterionComparison[];
}

export interface RegressionInput {
  readonly candidate: readonly RegressionSample[];
  readonly baseline: readonly RegressionSample[];
  /** Every criterion the run was SUPPOSED to score. Drives `no-candidate`. */
  readonly expectedCriterionIds: readonly EvalCriterionId[];
  readonly criterionNames: ReadonlyMap<string, string>;
  readonly baselineVersionId: AgentVersionId | null;
  readonly thresholdPoints: number;
}

export function compareToBaseline(input: RegressionInput): RegressionReport {
  const candidate = group(input.candidate);
  const baseline = group(input.baseline);
  const criterionIds = new Set<string>([
    ...input.expectedCriterionIds,
    ...candidate.keys(),
    ...baseline.keys(),
  ]);

  let regressed = false;
  let complete = true;
  const perCriterion: CriterionComparison[] = [];
  for (const criterionId of [...criterionIds].sort()) {
    const candidateScores = candidate.get(criterionId) ?? [];
    const baselineScores = baseline.get(criterionId) ?? [];
    const candidateMean = candidateScores.length === 0 ? null : meanOf(candidateScores);
    const baselineMean = baselineScores.length === 0 ? null : meanOf(baselineScores);

    let verdict: RegressionVerdict;
    let delta = 0;
    if (candidateMean === null) {
      verdict = "no-candidate";
      complete = false;
    } else if (baselineMean === null) {
      verdict = "no-baseline";
    } else {
      const exact = candidateMean - baselineMean;
      delta = exact;
      if (exact <= -input.thresholdPoints) {
        verdict = "regressed";
        regressed = true;
      } else if (exact >= input.thresholdPoints) {
        verdict = "improved";
      } else {
        verdict = "neutral";
      }
    }

    perCriterion.push({
      criterionId: criterionId as EvalCriterionId,
      criterionName: input.criterionNames.get(criterionId) ?? null,
      baselineMean: baselineMean === null ? null : roundToTwo(baselineMean),
      candidateMean: candidateMean === null ? null : roundToTwo(candidateMean),
      candidateSamples: candidateScores.length,
      baselineSamples: baselineScores.length,
      delta: roundToTwo(delta),
      verdict,
    });
  }

  return { regressed, complete, baselineVersionId: input.baselineVersionId, perCriterion };
}

function group(samples: readonly RegressionSample[]): Map<string, number[]> {
  const byCriterion = new Map<string, number[]>();
  for (const sample of samples) {
    const held = byCriterion.get(sample.criterionId);
    if (held === undefined) byCriterion.set(sample.criterionId, [sample.score]);
    else held.push(sample.score);
  }
  return byCriterion;
}
