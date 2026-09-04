import { describe, expect, it } from "vitest";

import { admitRatingComment, admitRatingValue, nextRevision, tally, type MessageRating } from "./rating.js";

describe("admitRatingValue", () => {
  it("admits the only two values the column may hold", () => {
    expect(admitRatingValue(1)).toEqual({ ok: true, value: 1 });
    expect(admitRatingValue(-1)).toEqual({ ok: true, value: -1 });
  });

  it("REFUSES zero — a neutral vote is no vote", () => {
    const admitted = admitRatingValue(0);
    expect(admitted.ok).toBe(false);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_RATING_VALUE_INVALID");
  });

  it("REFUSES any other integer", () => {
    expect(admitRatingValue(2).ok).toBe(false);
    expect(admitRatingValue(-2).ok).toBe(false);
    expect(admitRatingValue(100).ok).toBe(false);
  });

  it("REFUSES a fraction that rounds to one, rather than truncating it", () => {
    expect(admitRatingValue(1.0000001).ok).toBe(false);
    expect(admitRatingValue(0.9999999).ok).toBe(false);
  });

  it("REFUSES NaN and infinity before any equality is taken", () => {
    expect(admitRatingValue(Number.NaN).ok).toBe(false);
    expect(admitRatingValue(Number.POSITIVE_INFINITY).ok).toBe(false);
  });
});

describe("admitRatingComment", () => {
  it("keeps a comment, trimmed", () => {
    expect(admitRatingComment("  helpful  ", 100)).toEqual({ ok: true, value: "helpful" });
  });

  it("turns an absent or all-whitespace comment into null, not a blank string", () => {
    expect(admitRatingComment(null, 100)).toEqual({ ok: true, value: null });
    expect(admitRatingComment(undefined, 100)).toEqual({ ok: true, value: null });
    expect(admitRatingComment("   ", 100)).toEqual({ ok: true, value: null });
  });

  it("admits a comment at EXACTLY the ceiling", () => {
    // The literal is five characters and the ceiling is the literal 5: neither
    // is derived from the other, so moving the constant cannot keep this green.
    expect(admitRatingComment("abcde", 5)).toEqual({ ok: true, value: "abcde" });
  });

  it("REFUSES one character over the ceiling, and does not truncate it", () => {
    const admitted = admitRatingComment("abcdef", 5);
    expect(admitted.ok).toBe(false);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_RATING_COMMENT_TOO_LONG");
    expect(!admitted.ok && admitted.error.details).toEqual({ length: 6, maximum: 5 });
  });

  it("measures the TRIMMED length, so padding cannot breach the ceiling", () => {
    expect(admitRatingComment("   abcde   ", 5).ok).toBe(true);
  });
});

describe("nextRevision", () => {
  it("starts a fresh vote at 1", () => {
    expect(nextRevision(null)).toBe(1);
  });

  it("increments an existing one, so a race converges on a revision", () => {
    expect(nextRevision({ revision: 4 } as MessageRating)).toBe(5);
  });
});

describe("tally", () => {
  it("counts ups and downs", () => {
    expect(tally([{ rating: 1 }, { rating: 1 }, { rating: -1 }])).toEqual({ ups: 2, downs: 1, discarded: 0 });
  });

  it("does NOT fold an unreadable row silently into either count", () => {
    // The source's fold is `if (r > 0) ups++ else if (r < 0) downs++`, and
    // `total = ups + downs`, so a legacy zero row vanishes from both counts AND
    // from the denominator. Here it is counted where a reader can see it.
    expect(tally([{ rating: 1 }, { rating: 0 }])).toEqual({ ups: 1, downs: 0, discarded: 1 });
  });

  it("discards a row whose stored value is out of range in either direction", () => {
    expect(tally([{ rating: 7 }, { rating: -7 }])).toEqual({ ups: 0, downs: 0, discarded: 2 });
  });

  it("conserves: every row lands in exactly one of the three counters", () => {
    const rows = [{ rating: 1 }, { rating: -1 }, { rating: 0 }, { rating: 1 }, { rating: 42 }];
    const counted = tally(rows);
    expect(counted.ups + counted.downs + counted.discarded).toBe(rows.length);
  });

  it("counts nothing for no rows", () => {
    expect(tally([])).toEqual({ ups: 0, downs: 0, discarded: 0 });
  });
});
