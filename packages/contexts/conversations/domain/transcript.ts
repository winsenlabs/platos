// From stored turns to the history a model is actually shown.
//
// THIS IS THE MOST CONSEQUENTIAL LOSSY STEP IN THE WHOLE ENGINE AND THE SOURCE
// PERFORMS IT IN SIX LINES INSIDE A REPOSITORY METHOD. `loadHistory` flattens
// each turn to `{role:"user", content: inputText}` and
// `{role:"assistant", content: outputText}` and drops everything else: the tool
// calls, the tool results, the thinking content, the structured output and the
// usage. So a model replaying its own history sees plain text and no record that
// it ever called a tool. That is a real product decision with real consequences
// — an agent cannot see what it did last turn — and it is transcribed here
// rather than quietly changed, because changing it changes what every existing
// agent remembers. `TranscriptEntry` carries the dropped fields so the decision
// is VISIBLE and reversible at the boundary rather than invisible in a `map`.
//
// FOUR FILTERS DECIDE WHAT IS EVEN A CANDIDATE, and each has a reason:
//
//   SUCCEEDED ONLY. A failed turn's half-written output is not something to
//   replay, and an in-flight turn's output does not exist yet. This is why a
//   turn that crashed is invisible to the next one.
//   NO SUB-THREADS. `parentTurnId: null` by default — a reply turn belongs to
//   its own branch and would otherwise appear twice.
//   AFTER THE COMPACTION CURSOR. Turns the summary already stands for are
//   excluded; including them would show the model the prefix twice.
//   THE INHERITED PREFIX, ONLY WHEN THERE IS NO CURSOR. A compacted fork's
//   summary already covers its ancestry, so prepending the ancestor turns as
//   well would duplicate it. The source has this rule and it is easy to lose.
//
// THE WINDOW KEEPS THE NEWEST, WHICH IS WHY IT IS TAKEN FROM THE END. The source
// reads `sequence desc` then reverses, so hitting the ceiling drops the OLDEST
// turns. Taking the first N instead would show a model the beginning of a
// conversation and none of the part it is in.

import type { Thread } from "./thread.js";
import type { Turn } from "./turn.js";

export type TranscriptRole = "user" | "assistant";

/**
 * One side of one turn, plus what the flattening drops.
 *
 * `toolCallCount` and `thinkingContent` are carried and NOT rendered. They are
 * here so a caller that wants to change the decision above has the material to
 * change it with, and so a reader can see exactly what is being left out.
 */
export interface TranscriptEntry {
  readonly role: TranscriptRole;
  readonly text: string;
  readonly turnId: Turn["turnId"];
  readonly sequence: number;
  /** How many tool calls this turn made. Never rendered into the prompt today. */
  readonly toolCallCount: number;
  /** The model's reasoning. Never rendered into the prompt today. */
  readonly thinkingContent: string | null;
}

export interface TranscriptRequest {
  readonly thread: Thread;
  /** The inherited prefix, resolved, in `forkedTurnIds` order. */
  readonly inheritedTurns: readonly Turn[];
  /** This thread's own turns, in ascending sequence. */
  readonly ownTurns: readonly Turn[];
  /** The sequence the compaction cursor sits at. Zero when uncompacted. */
  readonly compactedUpToSequence: number;
  /** Ceiling on ENTRIES, not turns: one turn is up to two entries. */
  readonly maxEntries: number;
  /** Include reply turns. Default false, matching the source. */
  readonly includeSubThreads?: boolean;
}

export interface Transcript {
  readonly entries: readonly TranscriptEntry[];
  /** The compaction summary that stands in for everything before the cursor. */
  readonly summary: string | null;
  /** True when the window dropped older entries. A caller may want to say so. */
  readonly truncated: boolean;
}

function eligible(turn: Turn, includeSubThreads: boolean): boolean {
  if (turn.status !== "SUCCEEDED") return false;
  if (!includeSubThreads && turn.parentTurnId !== null) return false;
  return true;
}

function entriesFor(turn: Turn, toolCallCount: number): readonly TranscriptEntry[] {
  const sides: TranscriptEntry[] = [];
  if (turn.inputText !== null && turn.inputText !== "") {
    sides.push({
      role: "user",
      text: turn.inputText,
      turnId: turn.turnId,
      sequence: turn.sequence,
      toolCallCount: 0,
      thinkingContent: null,
    });
  }
  if (turn.outputText !== null && turn.outputText !== "") {
    sides.push({
      role: "assistant",
      text: turn.outputText,
      turnId: turn.turnId,
      sequence: turn.sequence,
      toolCallCount,
      thinkingContent: turn.thinkingContent,
    });
  }
  return sides;
}

/**
 * Build the history for one turn's prompt.
 *
 * `toolCallCounts` is a lookup rather than a field on `Turn` because tool calls
 * hang off a `Step` and this context does not load them to render a transcript
 * — the count is what a caller has cheaply, and it is all this needs to record
 * what was dropped.
 */
export function buildTranscript(
  request: TranscriptRequest,
  toolCallCounts: ReadonlyMap<Turn["turnId"], number> = new Map(),
): Transcript {
  const includeSubThreads = request.includeSubThreads ?? false;
  const compacted = request.compactedUpToSequence > 0;

  const inherited = compacted
    ? []
    : request.inheritedTurns.filter((turn) => eligible(turn, includeSubThreads));
  const own = request.ownTurns.filter(
    (turn) => eligible(turn, includeSubThreads) && turn.sequence > request.compactedUpToSequence,
  );

  const all: TranscriptEntry[] = [];
  for (const turn of [...inherited, ...own]) {
    all.push(...entriesFor(turn, toolCallCounts.get(turn.turnId) ?? 0));
  }

  const ceiling = Math.max(0, request.maxEntries);
  const truncated = all.length > ceiling;
  const entries = truncated ? all.slice(all.length - ceiling) : all;

  return Object.freeze({
    entries: Object.freeze(entries),
    summary: compacted ? request.thread.summary : null,
    truncated,
  });
}
