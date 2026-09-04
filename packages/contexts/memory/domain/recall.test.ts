import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { MemoryId } from "./identifiers.js";
import {
  admitPage,
  admitRecall,
  blendedRecallScore,
  BULK_DELETE_MAX,
  CANDIDATE_MULTIPLE,
  candidateWindow,
  clampInteger,
  CONFIDENCE_WEIGHT,
  DEFAULT_RECALL_LIMIT,
  MAX_CANDIDATES,
  MAX_RECALL_LIMIT,
  OFFSET_MAX,
  PAGE_MAX,
  rankCandidate,
  rankRecall,
  SIMILARITY_WEIGHT,
  type RecallCandidate,
} from "./recall.js";

function candidate(id: string, score: number, confidence: number | null): RecallCandidate {
  return { memoryId: asIdentifier<MemoryId>(id), score, confidence };
}

describe("the blend", () => {
  it("is 80% similarity and 20% confidence", () => {
    expect(SIMILARITY_WEIGHT).toBe(0.8);
    expect(CONFIDENCE_WEIGHT).toBeCloseTo(0.2, 10);
    expect(blendedRecallScore(1, 1)).toBeCloseTo(1, 10);
    expect(blendedRecallScore(0, 0)).toBe(0);
    expect(blendedRecallScore(0.5, 1)).toBeCloseTo(0.6, 10);
  });

  it("treats a NULL confidence as neutral, not as zero", () => {
    expect(blendedRecallScore(0.5, null)).toBeCloseTo(0.5, 10);
    expect(blendedRecallScore(0.5, 0)).toBeCloseTo(0.4, 10);
  });

  it("bounds a confidence that arrived outside [0, 1]", () => {
    expect(blendedRecallScore(0, 5)).toBeCloseTo(0.2, 10);
    expect(blendedRecallScore(0, -5)).toBe(0);
  });

  it("keeps the raw similarity beside the blended score", () => {
    const ranked = rankCandidate(candidate("mem-1", 0.9, 0.2));
    expect(ranked.score).toBe(0.9);
    expect(ranked.rankingScore).toBeCloseTo(0.76, 10);
  });
});

describe("the candidate window", () => {
  it("is four times the page", () => {
    expect(CANDIDATE_MULTIPLE).toBe(4);
    expect(candidateWindow(10)).toBe(40);
  });

  it("is capped, so a wide page cannot fetch the whole store", () => {
    expect(candidateWindow(MAX_RECALL_LIMIT)).toBe(MAX_CANDIDATES);
    expect(candidateWindow(1000)).toBe(MAX_CANDIDATES);
  });
});

describe("rankRecall", () => {
  it("PROMOTES a slightly less similar memory that feedback confirmed", () => {
    const ranked = rankRecall(
      [candidate("mem-a", 0.90, 0.0), candidate("mem-b", 0.86, 1.0)],
      2,
      0,
    );
    expect(ranked.map((entry) => entry.memoryId)).toEqual(["mem-b", "mem-a"]);
  });

  it("leaves a clearly closer memory on top despite low confidence", () => {
    const ranked = rankRecall(
      [candidate("mem-a", 0.99, 0.0), candidate("mem-b", 0.50, 1.0)],
      2,
      0,
    );
    expect(ranked[0]?.memoryId).toBe("mem-a");
  });

  it("applies `minScore` to the RAW similarity, not to the blend", () => {
    // Blended, mem-b scores 0.8 * 0.4 + 0.2 * 1 = 0.52, which is over the floor.
    // The floor is about similarity, so it is still cut.
    const ranked = rankRecall([candidate("mem-a", 0.6, 0), candidate("mem-b", 0.4, 1)], 5, 0.5);
    expect(ranked.map((entry) => entry.memoryId)).toEqual(["mem-a"]);
  });

  it("breaks ties by memory id ASCENDING, which is total and stable", () => {
    const ranked = rankRecall(
      [candidate("mem-c", 0.5, 0.5), candidate("mem-a", 0.5, 0.5), candidate("mem-b", 0.5, 0.5)],
      3,
      0,
    );
    expect(ranked.map((entry) => entry.memoryId)).toEqual(["mem-a", "mem-b", "mem-c"]);
  });

  it("cuts to the page AFTER ranking", () => {
    const ranked = rankRecall(
      [candidate("mem-a", 0.9, 0), candidate("mem-b", 0.86, 1), candidate("mem-c", 0.85, 1)],
      2,
      0,
    );
    expect(ranked).toHaveLength(2);
    expect(ranked.map((entry) => entry.memoryId)).toEqual(["mem-b", "mem-c"]);
  });

  it("never mutates its input", () => {
    const candidates = [candidate("mem-b", 0.5, null), candidate("mem-a", 0.9, null)];
    rankRecall(candidates, 2, 0);
    expect(candidates.map((entry) => entry.memoryId)).toEqual(["mem-b", "mem-a"]);
  });
});

describe("admitRecall", () => {
  it("requires a query that is not only whitespace", () => {
    const admitted = admitRecall("   ", 10, 0);
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.code).toBe("MEMORY_QUERY_INVALID");
    expect(admitted.error.fields[0]?.field).toBe("query");
  });

  it("defaults the page and derives the candidate window from it", () => {
    const admitted = admitRecall("tea", undefined, undefined);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.limit).toBe(DEFAULT_RECALL_LIMIT);
    expect(admitted.value.minScore).toBe(0);
    expect(admitted.value.candidateLimit).toBe(candidateWindow(DEFAULT_RECALL_LIMIT));
  });

  it("clamps a page a caller asked for to the ceiling", () => {
    const admitted = admitRecall("tea", 1000, undefined);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.limit).toBe(MAX_RECALL_LIMIT);
  });

  it("refuses a `minScore` outside [0, 1]", () => {
    expect(admitRecall("tea", 10, -0.1).ok).toBe(false);
    expect(admitRecall("tea", 10, 1.1).ok).toBe(false);
    expect(admitRecall("tea", 10, Number.NaN).ok).toBe(false);
    expect(admitRecall("tea", 10, 1).ok).toBe(true);
  });
});

describe("page bounds", () => {
  it("clamps the limit and the offset independently", () => {
    expect(admitPage(1000, -5)).toEqual({ limit: PAGE_MAX, offset: 0 });
    expect(admitPage(10, 20)).toEqual({ limit: 10, offset: 20 });
    expect(admitPage(undefined, undefined).limit).toBeGreaterThan(0);
  });

  it("honours a narrower ceiling when one is supplied", () => {
    expect(admitPage(500, 0, 20, OFFSET_MAX).limit).toBe(20);
  });
});

describe("clampInteger", () => {
  it("truncates toward zero before clamping", () => {
    expect(clampInteger(7.9, 1, 100)).toBe(7);
    expect(clampInteger(-7.9, -100, 100)).toBe(-7);
  });

  it("sends a NON-FINITE value to the MINIMUM, never the maximum", () => {
    // Both directions: a caller sending garbage for a limit must not be handed
    // the widest page the surface allows.
    expect(clampInteger(Number.NaN, 1, 100)).toBe(1);
    expect(clampInteger(Number.POSITIVE_INFINITY, 1, 100)).toBe(1);
    expect(clampInteger(Number.NEGATIVE_INFINITY, 1, 100)).toBe(1);
  });

  it("bulk deletion is capped at a hundred", () => {
    expect(BULK_DELETE_MAX).toBe(100);
  });
});
