// The compaction lock, the cursor, and the summary ceiling — three guards.
//
// Mutations M-K1 (the lock), M-K2 (the cursor), M-K3 (the summary ceiling). They
// have three codes because holding the lock says nothing about whether the
// cursor is sane, and a well-formed cursor says nothing about the summary.

import { describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import { DEFAULT_CONVERSATIONS_POLICY } from "./policy.js";
import {
  beginCompaction,
  completeCompaction,
  planCompaction,
  releaseCompaction,
} from "./thread-compaction.js";
import { openThread } from "./thread.js";
import { openTurn, type Turn } from "./turn.js";
import type { AgentId, AgentVersionId, EndUserId, ThreadId, TurnId } from "./identifiers.js";

const POLICY = DEFAULT_CONVERSATIONS_POLICY.compaction;
const AT = new Date("2026-01-01T00:00:00.000Z");

function thread() {
  const opened = openThread(
    {
      threadId: asIdentifier<ThreadId>("thread-1"),
      agentId: asIdentifier<AgentId>("agent-1"),
      endUserId: asIdentifier<EndUserId>("end-user-1"),
      at: AT,
    },
    DEFAULT_CONVERSATIONS_POLICY.thread,
  );
  if (!opened.ok) throw new Error(opened.error.code);
  return opened.value;
}

function turn(sequence: number): Turn {
  const opened = openTurn(
    {
      turnId: asIdentifier<TurnId>(`turn-${sequence}`),
      threadId: asIdentifier<ThreadId>("thread-1"),
      agentVersionId: asIdentifier<AgentVersionId>("ver-1"),
      versionBucket: "CURRENT",
      sequence,
      inputText: `m${sequence}`,
      at: AT,
    },
    DEFAULT_CONVERSATIONS_POLICY.turn,
  );
  if (!opened.ok) throw new Error(opened.error.code);
  return opened.value;
}

const TWENTY = Array.from({ length: 20 }, (_, index) => turn(index + 1));

describe("beginCompaction — the lock", () => {
  it("takes an IDLE thread to IN_PROGRESS", () => {
    const taken = beginCompaction(thread());
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.value.compactionState).toBe("IN_PROGRESS");
  });

  it("refuses a thread already IN_PROGRESS, as a conflict", () => {
    const first = beginCompaction(thread());
    if (!first.ok) throw new Error(first.error.code);
    const second = beginCompaction(first.value);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("CONVERSATIONS_COMPACTION_IN_PROGRESS");
    expect(second.error.category).toBe("conflict");
  });
});

describe("planCompaction", () => {
  it("keeps the newest `contextLimit` turns and plans the rest", () => {
    const plan = planCompaction(TWENTY, 8, POLICY);
    expect(plan).not.toBeNull();
    expect(plan?.turns).toHaveLength(12);
    expect(plan?.cursorSequence).toBe(12);
    expect(plan?.cursorTurnId).toBe("turn-12");
  });

  it("answers NULL rather than an error when there is too little to be worth it", () => {
    // Runs on a schedule; making "nothing to do" a refusal would fill the log
    // with failures that are the system working.
    expect(planCompaction(TWENTY, 18, POLICY)).toBeNull();
    expect(planCompaction(TWENTY.slice(0, 3), 0, POLICY)).toBeNull();
  });

  it("plans at exactly the minimum and refuses one below it", () => {
    const atMinimum = planCompaction(TWENTY, 20 - POLICY.minTurnsToCompact, POLICY);
    expect(atMinimum?.turns).toHaveLength(POLICY.minTurnsToCompact);
    expect(planCompaction(TWENTY, 20 - POLICY.minTurnsToCompact + 1, POLICY)).toBeNull();
  });
});

describe("releaseCompaction", () => {
  it("returns the lock without writing a summary or a cursor", () => {
    const taken = beginCompaction(thread());
    if (!taken.ok) throw new Error(taken.error.code);
    const released = releaseCompaction(taken.value);
    expect(released.compactionState).toBe("IDLE");
    expect(released.summary).toBeNull();
    expect(released.compactedUpToTurnId).toBeNull();
  });
});

describe("completeCompaction", () => {
  const result = (overrides: Record<string, unknown> = {}) => ({
    summary: "a summary",
    cursorTurnId: asIdentifier<TurnId>("turn-12"),
    cursorSequence: 12,
    previousCursorSequence: 0,
    at: AT,
    ...overrides,
  });

  it("stores the summary, advances the cursor and releases the lock", () => {
    const taken = beginCompaction(thread());
    if (!taken.ok) throw new Error(taken.error.code);
    const done = completeCompaction(taken.value, result(), POLICY);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.summary).toBe("a summary");
    expect(done.value.compactedUpToTurnId).toBe("turn-12");
    expect(done.value.compactedAt).toEqual(AT);
    expect(done.value.compactionState).toBe("IDLE");
  });

  it("refuses a cursor that moved BACKWARDS, which would re-expose compacted turns", () => {
    const taken = beginCompaction(thread());
    if (!taken.ok) throw new Error(taken.error.code);
    const refused = completeCompaction(
      taken.value,
      result({ cursorSequence: 5, previousCursorSequence: 12 }),
      POLICY,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_COMPACTION_CURSOR_REGRESSED");
    expect(refused.error.details.from).toBe(12);
    expect(refused.error.details.to).toBe(5);
  });

  it("refuses a cursor that did not move at all", () => {
    const taken = beginCompaction(thread());
    if (!taken.ok) throw new Error(taken.error.code);
    const refused = completeCompaction(
      taken.value,
      result({ cursorSequence: 12, previousCursorSequence: 12 }),
      POLICY,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_COMPACTION_CURSOR_REGRESSED");
  });

  it("refuses an over-long summary with a DIFFERENT code, before touching the cursor", () => {
    const taken = beginCompaction(thread());
    if (!taken.ok) throw new Error(taken.error.code);
    const refused = completeCompaction(
      taken.value,
      result({
        summary: "z".repeat(POLICY.maxSummaryLength + 1),
        cursorSequence: 5,
        previousCursorSequence: 12,
      }),
      POLICY,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // BOTH guards would refuse this input. The summary check runs first, so
    // deleting it cannot be masked by the cursor check.
    expect(refused.error.code).toBe("CONVERSATIONS_COMPACTION_SUMMARY_TOO_LONG");
    expect(refused.error.details.maximum).toBe(POLICY.maxSummaryLength);
  });

  it("admits a summary at exactly the ceiling", () => {
    const taken = beginCompaction(thread());
    if (!taken.ok) throw new Error(taken.error.code);
    const done = completeCompaction(
      taken.value,
      result({ summary: "z".repeat(POLICY.maxSummaryLength) }),
      POLICY,
    );
    expect(done.ok).toBe(true);
  });
});
