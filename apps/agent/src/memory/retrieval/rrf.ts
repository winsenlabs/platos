/**
 * Reciprocal Rank Fusion — ported from winsen-bridge's context-compiler/rrf.ts
 * (the one piece of Bridge's brain.context worth lifting near-verbatim).
 *
 * Classical RRF (Cormack/Clarke/Buettcher 2009): a candidate appearing at
 * 0-based rank `r` in a signal's ranked list contributes `1/(K + r + 1)`; its
 * fused score is the sum across signals. K=60 is the canonical constant — it
 * damps the head so one signal's #1 can't drown a candidate that is top-5 in
 * two others.
 *
 * DETERMINISM (the property that makes retrieval reproducible + testable):
 *   - Signals are summed in sorted-name order — float addition is
 *     order-sensitive, so a fixed order gives byte-identical scores.
 *   - Ties on score break by key ASC (lexicographic) — total and stable.
 *   - A duplicate key WITHIN one signal's list counts once (first position
 *     wins), so a buggy signal can't double-vote.
 */
export const RRF_K = 60;

export interface FusedEntry {
  key: string;
  score: number;
  /** Which signals surfaced this key (accounting / debug). */
  signals: string[];
}

/**
 * Fuse per-signal ranked key lists into one ranked list.
 * @param rankings signal-name → ordered candidate keys (best first)
 */
export function rrfFuse(rankings: ReadonlyMap<string, readonly string[]>): FusedEntry[] {
  const scores = new Map<string, { score: number; signals: string[] }>();
  const signalNames = [...rankings.keys()].sort();
  for (const signal of signalNames) {
    const seen = new Set<string>();
    const list = rankings.get(signal)!;
    for (let r = 0; r < list.length; r++) {
      const key = list[r]!;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = scores.get(key) ?? { score: 0, signals: [] };
      entry.score += 1 / (RRF_K + r + 1);
      entry.signals.push(signal);
      scores.set(key, entry);
    }
  }
  return [...scores.entries()]
    .map(([key, { score, signals }]) => ({ key, score, signals }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.key < b.key ? -1 : 1));
}
