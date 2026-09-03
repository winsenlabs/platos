// An in-memory `EmbeddingModel`, and the similarity the in-memory stores use.
//
// IT IS DETERMINISTIC AND IT IS NOT SEMANTIC. Two identical strings embed to the
// same vector; two similar strings do not embed near each other. That is the
// right trade for this package's tests: what is under test is the RANKING —
// overfetch, blend, tie-break, fusion — and a ranking test needs a similarity it
// can predict exactly, not one that approximates meaning.
//
// So a test that wants "this memory is closer than that one" seeds the two with
// text that SHARES TOKENS with the query in known proportions, and
// `cosineSimilarity` below is the same function the in-memory store uses. Any
// test that depended on a real model would be measuring the model.
//
// The width is the real one — 1536 — so `isStorableEmbedding` is exercised
// against a vector of the shape the column actually takes, and a test can ask
// for a wrong-width vector explicitly to prove the refusal.

import { err, ok, type Result } from "@platos/kernel";

import { embeddingUnavailable } from "../../domain/index.js";
import { EMBEDDING_DIMENSIONS, type EmbeddingModel } from "../ports/index.js";

/** A token's contribution, folded into a bucket by a stable hash. */
function bucketOf(token: string): number {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = (Math.imul(hash, 31) + token.charCodeAt(index)) >>> 0;
  }
  return hash % EMBEDDING_DIMENSIONS;
}

/**
 * A bag-of-tokens vector, L2-normalised.
 *
 * Normalising is what makes the cosine of two identical strings exactly 1 and
 * keeps every score in [0, 1] — the interval `minScore` and the blend both
 * assume.
 */
export function deterministicEmbedding(text: string): readonly number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length > 0);
  for (const token of tokens) {
    const bucket = bucketOf(token);
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
  if (magnitude === 0) {
    // An empty or punctuation-only string still has to produce a STORABLE
    // vector: the refusal this package tests is about width, not about content.
    vector[0] = 1;
    return vector;
  }
  return vector.map((component) => component / magnitude);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return dot;
}

export class InMemoryEmbeddingModel implements EmbeddingModel {
  /** Every text this model was asked to embed, in order. */
  readonly requests: string[] = [];

  private failure: string | null = null;
  private width: number = EMBEDDING_DIMENSIONS;

  /** Make the next and every subsequent call fail. */
  failWith(reason: string): void {
    this.failure = reason;
  }

  /** Return a vector of the wrong width, to exercise the storability check. */
  returnWidth(width: number): void {
    this.width = width;
  }

  async embed(text: string): Promise<Result<readonly number[]>> {
    this.requests.push(text);
    if (this.failure !== null) return err(embeddingUnavailable(this.failure));
    const vector = deterministicEmbedding(text);
    return ok(this.width === EMBEDDING_DIMENSIONS ? vector : vector.slice(0, this.width));
  }
}
