// Ranking: how a set of vector-search candidates becomes the page a turn sees.
//
// The store answers with candidates ordered by cosine distance. That order is
// NOT the answer: a memory the subject has confirmed should outrank a marginally
// closer one they have not, which is the whole reason feedback moves confidence
// at all. So ranking happens here, over candidates, and the two numbers stay
// separate all the way to the caller:
//
//   score         raw cosine similarity. What `minScore` is applied to, and what
//                 a caller comparing against a previously recorded threshold
//                 means. Blending into it would silently move every threshold an
//                 installation had tuned.
//   rankingScore  80% similarity, 20% confidence. What the page is ordered by.
//
// OVERFETCHING IS REQUIRED, NOT AN OPTIMISATION. Reranking only the requested
// page can never promote a slightly less similar memory after positive feedback
// — it was already excluded by the store's ordering. The source records this in
// as many words, and `candidateWindow` below is its `min(limit * 4, 200)`.
//
// DETERMINISM IS PART OF THE CONTRACT. Ties on `rankingScore` break by memory id
// ascending, which is total and stable, so two identical queries return the same
// page in the same order and a retrieval test can assert a list rather than a
// set.

import { err, ok, type Result } from "@platos/kernel";

import { boundedConfidence, NEUTRAL_CONFIDENCE } from "./confidence.js";
import { queryInvalid } from "./errors.js";
import type { MemoryId } from "./identifiers.js";

/** Weight on cosine similarity. The remainder is confidence's. */
export const SIMILARITY_WEIGHT = 0.8;
export const CONFIDENCE_WEIGHT = 1 - SIMILARITY_WEIGHT;

/** How many candidates are fetched per requested result, and the hard ceiling. */
export const CANDIDATE_MULTIPLE = 4;
export const MAX_CANDIDATES = 200;

/** The recall page bounds. A caller asking for more gets the ceiling. */
export const DEFAULT_RECALL_LIMIT = 10;
export const MAX_RECALL_LIMIT = 50;

/** One candidate as the store returns it, before ranking. */
export interface RecallCandidate {
  readonly memoryId: MemoryId;
  /** Cosine similarity in [0, 1]; `1 - distance` as the store computes it. */
  readonly score: number;
  readonly confidence: number | null;
}

export interface RankedRecall extends RecallCandidate {
  readonly rankingScore: number;
}

/**
 * The blended order.
 *
 * A null confidence is NEUTRAL rather than zero. Zero would push every memory an
 * extractor never scored — which is every manually written one — below every
 * scored memory regardless of similarity, and manual memories are the ones an
 * operator most expects to be recalled.
 */
export function blendedRecallScore(similarity: number, confidence: number | null): number {
  const bounded = boundedConfidence(confidence ?? NEUTRAL_CONFIDENCE);
  return similarity * SIMILARITY_WEIGHT + bounded * CONFIDENCE_WEIGHT;
}

export function rankCandidate(candidate: RecallCandidate): RankedRecall {
  return { ...candidate, rankingScore: blendedRecallScore(candidate.score, candidate.confidence) };
}

/** How many candidates to ask the store for, given the page a caller wants. */
export function candidateWindow(limit: number): number {
  return Math.min(limit * CANDIDATE_MULTIPLE, MAX_CANDIDATES);
}

/**
 * Rank, cut and page.
 *
 * Filtering happens BEFORE ranking, on the raw similarity, so `minScore` means
 * what a caller thinks it means: "nothing less similar than this", not "nothing
 * whose blended score is under this".
 */
export function rankRecall(
  candidates: readonly RecallCandidate[],
  limit: number,
  minScore: number,
): readonly RankedRecall[] {
  return candidates
    .filter((candidate) => candidate.score >= minScore)
    .map(rankCandidate)
    .sort(byRankingScore)
    .slice(0, limit);
}

/** Descending by blended score; ascending by id on a tie. Total and stable. */
export function byRankingScore(left: RankedRecall, right: RankedRecall): number {
  if (right.rankingScore !== left.rankingScore) return right.rankingScore - left.rankingScore;
  if (left.memoryId === right.memoryId) return 0;
  return left.memoryId < right.memoryId ? -1 : 1;
}

/** A recall request after admission: every bound already applied. */
export interface RecallBounds {
  readonly limit: number;
  readonly minScore: number;
  readonly candidateLimit: number;
}

/**
 * Admit a recall request.
 *
 * The query text is required and is trimmed first, because a query of spaces
 * embeds to a vector that is near-equidistant from everything and would return
 * an arbitrary page rather than nothing.
 */
export function admitRecall(
  query: string,
  limit: number | undefined,
  minScore: number | undefined,
): Result<RecallBounds> {
  if (query.trim().length === 0) return err(queryInvalid("a recall query is required", "query"));
  if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 1)) {
    return err(queryInvalid("minScore must be between 0 and 1", "minScore"));
  }
  const bounded = clampInteger(limit ?? DEFAULT_RECALL_LIMIT, 1, MAX_RECALL_LIMIT);
  return ok({
    limit: bounded,
    minScore: minScore ?? 0,
    candidateLimit: candidateWindow(bounded),
  });
}

/** The page bounds a listing uses. Separate ceilings per surface, per the source. */
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;
export const OFFSET_MAX = 100_000;
export const EXPORT_PAGE_MAX = 1_000;
export const BULK_DELETE_MAX = 100;

export interface PageBounds {
  readonly limit: number;
  readonly offset: number;
}

export function admitPage(
  limit: number | undefined,
  offset: number | undefined,
  maximumLimit: number = PAGE_MAX,
  maximumOffset: number = OFFSET_MAX,
): PageBounds {
  return {
    limit: clampInteger(limit ?? PAGE_DEFAULT, 1, maximumLimit),
    offset: clampInteger(offset ?? 0, 0, maximumOffset),
  };
}

/**
 * Truncate toward zero, then clamp. A non-finite value becomes the MINIMUM, not
 * the maximum: a caller sending `NaN` for a limit must not be handed the widest
 * page the surface allows.
 */
export function clampInteger(value: number, minimum: number, maximum: number): number {
  const truncated = Math.trunc(Number(value));
  if (!Number.isFinite(truncated)) return minimum;
  return Math.min(Math.max(truncated, minimum), maximum);
}
