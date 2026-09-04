// The synthesized profile — consolidation, and the rules that throttle it.
//
// The extraction judge only ever emits ATOMS: facts, preferences, events and
// relationships. A profile is a different thing — a short narrative of who the
// subject is — and before consolidation existed it was written only by explicit
// profile calls, so it never kept up on its own. Synthesis rolls the atoms this
// agent holds about this subject into one `kind = "profile"` row under the
// reserved key, which the turn-start profile injector already reads.
//
// IT IS AGENT-SCOPED, DELIBERATELY, AND CLUSTER-WIDENED THE SAME WAY EVERYTHING
// ELSE IS. A coach's profile of a person is not a sales agent's, and the memories
// the two hold are already separated by ownership; the profile is a projection of
// those memories and inherits their boundary rather than crossing it.
//
// THREE REFUSALS, AND EACH IS AN OUTCOME RATHER THAN A FAILURE:
//
//   throttled       a synthesis ran inside the window. The default is an hour,
//                   because the input is a slowly-changing set of durable facts
//                   and re-narrating it every sweep is spend with no signal.
//   too-few-atoms   under four atoms there is no narrative to write, only a list,
//                   and a narrative written from two facts reads as an
//                   over-confident summary of a person.
//   empty           the model returned nothing. Storing an empty profile would
//                   overwrite a good one with a blank.
//
// THE THROTTLE READS ITS OWN OUTPUT. `synthesizedAt` is stamped on the row's
// metadata, so the window is enforced from the stored value rather than from a
// cache or a lock — which means it survives a restart, and two workers racing
// still write the same row rather than two.

import type { MemoryMetadata } from "./content.js";
import type { Memory } from "./memory.js";
import { isAtomKind, RAG_SOURCE, SYNTHESIZED_PROFILE_KEY } from "./taxonomy.js";

/** How long a synthesized profile is considered current. One hour. */
export const DEFAULT_SYNTHESIS_THROTTLE_MS = 60 * 60 * 1000;

/** Below this many atoms there is nothing worth narrating. */
export const MIN_SYNTHESIS_ATOMS = 4;

/** How many atoms are shown to the model. The source's cap, unchanged. */
export const MAX_SYNTHESIS_ATOMS = 80;

export type SynthesisRefusal = "throttled" | "too-few-atoms" | "empty";

export type SynthesisDecision =
  | { readonly proceed: true; readonly atoms: readonly Memory[] }
  | { readonly proceed: false; readonly reason: SynthesisRefusal };

/** Is this the maintained narrative rather than a structured profile fact? */
export function isSynthesizedProfile(memory: Memory): boolean {
  return memory.kind === "profile" && memory.profileKey === SYNTHESIZED_PROFILE_KEY;
}

/** When the stored narrative was last written, or null when it never was. */
export function synthesizedAt(memory: Memory): Date | null {
  const stamped = memory.metadata?.["synthesizedAt"];
  if (typeof stamped !== "string") return null;
  const parsed = Date.parse(stamped);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * Is the stored narrative still inside its window?
 *
 * A row with no readable `synthesizedAt` is treated as STALE, not fresh. The
 * stamp is what the throttle is enforced from, and a row that lost it — an
 * import, a hand edit — should be re-synthesized rather than frozen forever.
 */
export function isWithinThrottle(prior: Memory | null, now: Date, throttleMs: number): boolean {
  if (prior === null) return false;
  const at = synthesizedAt(prior);
  if (at === null) return false;
  return now.getTime() - at.getTime() < throttleMs;
}

/**
 * The atoms a narrative is written from.
 *
 * Retrieval-augmented rows are excluded: they are ingested documents, not things
 * the subject said, and narrating them would produce a profile of a corpus.
 * Profile rows are excluded because they ARE the output — including them would
 * let each synthesis re-narrate its own last answer, and the profile would drift
 * away from the facts a sentence at a time.
 */
export function selectSynthesisAtoms(memories: readonly Memory[]): readonly Memory[] {
  return memories
    .filter((memory) => isAtomKind(memory.kind) && memory.source !== RAG_SOURCE)
    .slice(0, MAX_SYNTHESIS_ATOMS);
}

/** Throttle, then atom count. Both refusals are reported, never conflated. */
export function decideSynthesis(
  memories: readonly Memory[],
  prior: Memory | null,
  now: Date,
  options: { readonly force?: boolean; readonly throttleMs?: number } = {},
): SynthesisDecision {
  const throttleMs = options.throttleMs ?? DEFAULT_SYNTHESIS_THROTTLE_MS;
  if (options.force !== true && isWithinThrottle(prior, now, throttleMs)) {
    return { proceed: false, reason: "throttled" };
  }
  const atoms = selectSynthesisAtoms(memories);
  if (atoms.length < MIN_SYNTHESIS_ATOMS) return { proceed: false, reason: "too-few-atoms" };
  return { proceed: true, atoms };
}

/** The one-line-per-atom rendering the model is given. */
export function renderAtoms(atoms: readonly Memory[]): string {
  return atoms.map((memory) => `(${memory.kind}) ${memory.content}`).join("\n");
}

/** The metadata a synthesized row carries, and the throttle reads back. */
export function synthesisMetadata(now: Date, atomCount: number): MemoryMetadata {
  return {
    profileKey: SYNTHESIZED_PROFILE_KEY,
    synthesizedAt: now.toISOString(),
    atomCount,
  };
}

/** A narrative is stored only when it is non-empty after trimming. */
export function admitNarrative(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The projection a turn-start injector reads: one object keyed by profile key.
 *
 * Later rows win on a duplicate key. The store's upsert makes duplicates
 * impossible for one owner, but a cluster-widened read spans several owners, and
 * the newest write is the one an agent should see.
 */
export function projectProfile(memories: readonly Memory[]): Readonly<Record<string, string>> {
  const projection: Record<string, string> = {};
  for (const memory of [...memories].sort(byUpdatedAtAscending)) {
    if (memory.kind !== "profile" || memory.profileKey === null) continue;
    projection[memory.profileKey] = memory.content;
  }
  return Object.freeze(projection);
}

function byUpdatedAtAscending(left: Memory, right: Memory): number {
  return left.lifecycle.updatedAt.getTime() - right.lifecycle.updatedAt.getTime();
}
