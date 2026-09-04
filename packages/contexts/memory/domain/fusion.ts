// Reciprocal Rank Fusion — how two retrieval signals become one ranked list.
//
// Recall over the flat memory store is one cosine query, and the knowledge graph
// is write-only unless something reads it back. Fusion is that seam: a memory
// that is BOTH semantically close to the situation AND attached to an entity the
// situation resolved to collects a contribution from each signal and rises above
// one that is only close.
//
// CLASSICAL RRF (Cormack/Clarke/Buettcher, 2009). A candidate at 0-based rank
// `r` in a signal's list contributes `1 / (K + r + 1)`; its fused score is the
// sum across signals. K = 60 is the canonical constant, and it is the parameter
// that matters: it damps the head hard enough that one signal's first place
// cannot outweigh being top-five in two others. At K = 0 the first rank is worth
// 1 and everything else is noise beside it; at K = 60 the gap between rank 1 and
// rank 5 is about 6%.
//
// THREE DETERMINISM PROPERTIES, EACH LOAD-BEARING:
//
//   Signals are summed in SORTED NAME ORDER. Float addition is not associative,
//   so a fixed traversal order is what makes the scores byte-identical between
//   two runs that enumerate their signals differently.
//
//   Ties break by key ASCENDING. Total and stable, so a fused list is a value a
//   test can assert rather than a set it has to sort first.
//
//   A duplicate key WITHIN one signal counts ONCE, at its first position. A
//   signal that emitted the same candidate twice would otherwise vote twice, and
//   a buggy signal must not be able to outrank a correct one by repeating
//   itself.

/** The canonical damping constant. Not a tuning knob — see the note above. */
export const RRF_K = 60;

export interface FusedEntry {
  readonly key: string;
  readonly score: number;
  /** Which signals surfaced this key, in the same sorted order they were summed. */
  readonly signals: readonly string[];
}

/** One signal's contribution at a 0-based rank. */
export function rrfContribution(rank: number): number {
  return 1 / (RRF_K + rank + 1);
}

/**
 * Fuse per-signal ranked key lists into one ranked list.
 *
 * @param rankings signal name → ordered candidate keys, best first.
 */
export function rrfFuse(rankings: ReadonlyMap<string, readonly string[]>): readonly FusedEntry[] {
  const scores = new Map<string, { score: number; signals: string[] }>();

  for (const signal of [...rankings.keys()].sort()) {
    const list = rankings.get(signal) ?? [];
    const seen = new Set<string>();
    for (let rank = 0; rank < list.length; rank += 1) {
      const key = list[rank];
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);
      const entry = scores.get(key) ?? { score: 0, signals: [] };
      entry.score += rrfContribution(rank);
      entry.signals.push(signal);
      scores.set(key, entry);
    }
  }

  return [...scores.entries()]
    .map(([key, { score, signals }]) => ({ key, score, signals: Object.freeze(signals) }))
    .sort((left, right) =>
      right.score !== left.score ? right.score - left.score : left.key < right.key ? -1 : 1,
    );
}
