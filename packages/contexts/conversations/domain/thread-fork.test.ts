// Forking: two ceilings that bound different things, and one foreign key.
//
// Mutations M-F1 (fan-out), M-F2 (depth), M-F3 (foreign boundary turn). Each
// removes one `if` and turns exactly one named case red — which is only true
// because the two ceilings have DIFFERENT codes. Sharing one would let M-F1's
// deletion be masked by M-F2's guard.

import { describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import { DEFAULT_CONVERSATIONS_POLICY } from "./policy.js";
import { applyFork, planFork, totalTurnCount } from "./thread-fork.js";
import { openThread } from "./thread.js";
import { openTurn, type Turn } from "./turn.js";
import type { AgentId, AgentVersionId, EndUserId, ThreadId, TurnId } from "./identifiers.js";

const POLICY = DEFAULT_CONVERSATIONS_POLICY.thread;
const AT = new Date("2026-01-01T00:00:00.000Z");

function thread(id = "thread-1") {
  const opened = openThread(
    {
      threadId: asIdentifier<ThreadId>(id),
      agentId: asIdentifier<AgentId>("agent-1"),
      endUserId: asIdentifier<EndUserId>("end-user-1"),
      at: AT,
    },
    POLICY,
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
      inputText: `message ${sequence}`,
      at: AT,
    },
    DEFAULT_CONVERSATIONS_POLICY.turn,
  );
  if (!opened.ok) throw new Error(opened.error.code);
  return opened.value;
}

const TURNS = [turn(1), turn(2), turn(3), turn(4)];

function request(overrides: Record<string, unknown> = {}) {
  return {
    parent: thread(),
    parentTurns: TURNS,
    forkedUpToTurnId: asIdentifier<TurnId>("turn-2"),
    existingForkCount: 0,
    parentDepth: 0,
    ...overrides,
  } as Parameters<typeof planFork>[0];
}

describe("planFork", () => {
  it("takes the prefix UP TO AND INCLUDING the boundary turn, in order", () => {
    const plan = planFork(request(), POLICY);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.forkedTurnIds).toEqual(["turn-1", "turn-2"]);
    expect(plan.value.forkedUpToTurnId).toBe("turn-2");
    expect(plan.value.depth).toBe(1);
  });

  it("copies NO turn: the plan holds ids, and the ids are the parent's own", () => {
    const plan = planFork(request(), POLICY);
    if (!plan.ok) throw new Error(plan.error.code);
    for (const id of plan.value.forkedTurnIds) {
      expect(TURNS.some((existing) => existing.turnId === id)).toBe(true);
    }
  });

  it("refuses a boundary turn that is not in the parent — its own code", () => {
    const refused = planFork(
      request({ forkedUpToTurnId: asIdentifier<TurnId>("turn-from-elsewhere") }),
      POLICY,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_FORK_TURN_FOREIGN");
    expect(refused.error.details.turnId).toBe("turn-from-elsewhere");
  });

  it("refuses the FAN-OUT ceiling with its own code, at exactly the ceiling", () => {
    expect(planFork(request({ existingForkCount: POLICY.maxForksPerThread - 1 }), POLICY).ok).toBe(
      true,
    );
    const refused = planFork(request({ existingForkCount: POLICY.maxForksPerThread }), POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_FORK_CEILING_EXCEEDED");
    expect(refused.error.details.maximum).toBe(POLICY.maxForksPerThread);
  });

  it("refuses the DEPTH ceiling with a DIFFERENT code, at exactly the ceiling", () => {
    expect(planFork(request({ parentDepth: POLICY.maxForkDepth - 1 }), POLICY).ok).toBe(true);
    const refused = planFork(request({ parentDepth: POLICY.maxForkDepth }), POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_FORK_DEPTH_EXCEEDED");
    expect(refused.error.details.depth).toBe(POLICY.maxForkDepth + 1);
  });

  it("tells the two ceilings apart on a request that breaches only one", () => {
    const deepOnly = planFork(request({ parentDepth: POLICY.maxForkDepth }), POLICY);
    const wideOnly = planFork(request({ existingForkCount: POLICY.maxForksPerThread }), POLICY);
    expect(deepOnly.ok).toBe(false);
    expect(wideOnly.ok).toBe(false);
    if (deepOnly.ok || wideOnly.ok) return;
    expect(deepOnly.error.code).not.toBe(wideOnly.error.code);
  });
});

describe("applyFork", () => {
  it("stamps the ancestry onto the child and leaves its own turn list empty", () => {
    const plan = planFork(request(), POLICY);
    if (!plan.ok) throw new Error(plan.error.code);
    const child = applyFork(thread("thread-2"), plan.value);
    expect(child.parentThreadId).toBe("thread-1");
    expect(child.forkedUpToTurnId).toBe("turn-2");
    expect(child.forkedTurnIds).toEqual(["turn-1", "turn-2"]);
  });
});

describe("totalTurnCount", () => {
  it("adds the inherited prefix to the thread's own rows", () => {
    const plan = planFork(request(), POLICY);
    if (!plan.ok) throw new Error(plan.error.code);
    const child = applyFork(thread("thread-2"), plan.value);
    expect(totalTurnCount(child, 3)).toBe(5);
    // The count `_count.turns` alone would report is 3, which reads a fork as if
    // the conversation started at the branch point.
    expect(totalTurnCount(child, 3)).not.toBe(3);
  });
});
