// What a model is actually shown, and the four filters that decide it.
//
// Mutations M-X1 (SUCCEEDED-only), M-X2 (sub-threads), M-X3 (the compaction
// cursor), M-X4 (the inherited-prefix-only-when-uncompacted rule), M-X5 (the
// window takes the NEWEST). Each removes one branch of `buildTranscript` and
// turns exactly one named case red.

import { describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import { DEFAULT_CONVERSATIONS_POLICY } from "./policy.js";
import { openThread, type Thread } from "./thread.js";
import { buildTranscript } from "./transcript.js";
import { openTurn, type Turn } from "./turn.js";
import type { AgentId, AgentVersionId, EndUserId, ThreadId, TurnId } from "./identifiers.js";

const AT = new Date("2026-01-01T00:00:00.000Z");

function thread(overrides: Partial<Thread> = {}): Thread {
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
  return { ...opened.value, ...overrides };
}

function turn(sequence: number, overrides: Partial<Turn> = {}): Turn {
  const opened = openTurn(
    {
      turnId: asIdentifier<TurnId>(`turn-${sequence}`),
      threadId: asIdentifier<ThreadId>("thread-1"),
      agentVersionId: asIdentifier<AgentVersionId>("ver-1"),
      versionBucket: "CURRENT",
      sequence,
      inputText: `ask ${sequence}`,
      at: AT,
    },
    DEFAULT_CONVERSATIONS_POLICY.turn,
  );
  if (!opened.ok) throw new Error(opened.error.code);
  return { ...opened.value, status: "SUCCEEDED", outputText: `answer ${sequence}`, ...overrides };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    thread: thread(),
    inheritedTurns: [],
    ownTurns: [turn(1), turn(2)],
    compactedUpToSequence: 0,
    maxEntries: 100,
    ...overrides,
  } as Parameters<typeof buildTranscript>[0];
}

describe("buildTranscript", () => {
  it("flattens each turn to a user side and an assistant side, in order", () => {
    const built = buildTranscript(request());
    expect(built.entries.map((entry) => `${entry.role}:${entry.text}`)).toEqual([
      "user:ask 1",
      "assistant:answer 1",
      "user:ask 2",
      "assistant:answer 2",
    ]);
  });

  it("carries the tool-call count and the thinking it does NOT render", () => {
    const counts = new Map([[asIdentifier<TurnId>("turn-1"), 3]]);
    const built = buildTranscript(
      request({ ownTurns: [turn(1, { thinkingContent: "reasoning" })] }),
      counts,
    );
    const assistant = built.entries.find((entry) => entry.role === "assistant");
    expect(assistant?.toolCallCount).toBe(3);
    expect(assistant?.thinkingContent).toBe("reasoning");
    // The flattening drops both from the text. They are carried so the decision
    // is visible and reversible rather than invisible in a `map`.
    expect(assistant?.text).toBe("answer 1");
  });

  it("excludes a FAILED turn and a PENDING one, keeping only SUCCEEDED", () => {
    const built = buildTranscript(
      request({
        ownTurns: [turn(1), turn(2, { status: "FAILED" }), turn(3, { status: "PENDING" })],
      }),
    );
    expect(built.entries).toHaveLength(2);
    expect(built.entries.every((entry) => entry.sequence === 1)).toBe(true);
  });

  it("excludes a REPLY turn by default and includes it when asked", () => {
    const reply = turn(3, { parentTurnId: asIdentifier<TurnId>("turn-1") });
    const without = buildTranscript(request({ ownTurns: [turn(1), reply] }));
    expect(without.entries).toHaveLength(2);
    const with_ = buildTranscript(
      request({ ownTurns: [turn(1), reply], includeSubThreads: true }),
    );
    expect(with_.entries).toHaveLength(4);
  });

  it("starts AFTER the compaction cursor and carries the summary instead", () => {
    const built = buildTranscript(
      request({
        thread: thread({ summary: "what happened before" }),
        ownTurns: [turn(1), turn(2), turn(3)],
        compactedUpToSequence: 2,
      }),
    );
    expect(built.entries.map((entry) => entry.sequence)).toEqual([3, 3]);
    expect(built.summary).toBe("what happened before");
  });

  it("carries NO summary when nothing is compacted, even if the column holds one", () => {
    const built = buildTranscript(
      request({ thread: thread({ summary: "stale" }), compactedUpToSequence: 0 }),
    );
    expect(built.summary).toBeNull();
  });

  it("prepends an inherited prefix on an UNCOMPACTED fork", () => {
    const built = buildTranscript(
      request({ inheritedTurns: [turn(1)], ownTurns: [turn(2)], compactedUpToSequence: 0 }),
    );
    expect(built.entries.map((entry) => entry.text)).toEqual([
      "ask 1",
      "answer 1",
      "ask 2",
      "answer 2",
    ]);
  });

  it("DROPS the inherited prefix once the fork is compacted, so it is not shown twice", () => {
    const built = buildTranscript(
      request({
        thread: thread({ summary: "covers the ancestry" }),
        inheritedTurns: [turn(1)],
        ownTurns: [turn(2), turn(3)],
        compactedUpToSequence: 2,
      }),
    );
    expect(built.entries.map((entry) => entry.sequence)).toEqual([3, 3]);
    expect(built.summary).toBe("covers the ancestry");
  });

  it("keeps the NEWEST entries when the window is spent, never the oldest", () => {
    const built = buildTranscript(
      request({ ownTurns: [turn(1), turn(2), turn(3), turn(4)], maxEntries: 3 }),
    );
    expect(built.truncated).toBe(true);
    expect(built.entries).toHaveLength(3);
    expect(built.entries.map((entry) => entry.text)).toEqual([
      "assistant:answer 3".slice(10),
      "ask 4",
      "answer 4",
    ]);
  });

  it("does not mark a transcript truncated when it fits exactly", () => {
    const built = buildTranscript(request({ ownTurns: [turn(1), turn(2)], maxEntries: 4 }));
    expect(built.truncated).toBe(false);
    expect(built.entries).toHaveLength(4);
  });

  it("omits a side that has no text rather than rendering an empty message", () => {
    const built = buildTranscript(request({ ownTurns: [turn(1, { outputText: null })] }));
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]?.role).toBe("user");
  });
});
