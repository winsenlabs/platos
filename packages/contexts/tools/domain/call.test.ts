import { describe, expect, it } from "vitest";

import {
  admitSequence,
  beginCall,
  byTranscriptOrder,
  canTransition,
  CALL_STATUSES,
  completeCall,
  isTerminal,
  nextSequence,
  retryOf,
  TERMINAL_CALL_STATUSES,
  type CallStatus,
  type ToolCall,
} from "./call.js";
import {
  asToolsIdentifier,
  type StepId,
  type ToolCallId,
  type ToolId,
  type ToolName,
} from "./identifiers.js";

const STEP = asToolsIdentifier<StepId>("step-1");
const AT = new Date("2026-01-01T00:00:00.000Z");

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId: asToolsIdentifier<ToolCallId>("call-1"),
    stepId: STEP,
    toolId: asToolsIdentifier<ToolId>("tool-1"),
    sequence: 0,
    toolName: asToolsIdentifier<ToolName>("files.upload"),
    arguments: { path: "/a" },
    result: null,
    status: "PENDING",
    retryCount: 0,
    error: null,
    latencyMs: null,
    startedAt: null,
    completedAt: null,
    createdAt: AT,
    ...overrides,
  };
}

describe("the state machine", () => {
  it("declares the five statuses the shared WorkStatus enum holds", () => {
    expect([...CALL_STATUSES]).toEqual(["PENDING", "ACTIVE", "SUCCEEDED", "FAILED", "CANCELLED"]);
    expect([...TERMINAL_CALL_STATUSES]).toEqual(["SUCCEEDED", "FAILED", "CANCELLED"]);
  });

  it("lets a pending call start or be cancelled before it ever runs", () => {
    expect(canTransition("PENDING", "ACTIVE")).toBe(true);
    expect(canTransition("PENDING", "CANCELLED")).toBe(true);
    expect(canTransition("PENDING", "SUCCEEDED")).toBe(false);
  });

  it("makes every terminal state final, so a retry cannot overwrite a failure", () => {
    for (const status of TERMINAL_CALL_STATUSES) {
      expect(isTerminal(status)).toBe(true);
      for (const target of CALL_STATUSES) {
        expect(canTransition(status, target as CallStatus)).toBe(false);
      }
    }
  });

  it("refuses an illegal move with the two states named", () => {
    const finished = call({ status: "SUCCEEDED" });
    const again = beginCall(finished, AT);
    expect(!again.ok && again.error.code).toBe("TOOLS_CALL_TRANSITION_INVALID");
    expect(!again.ok && again.error.details["from"]).toBe("SUCCEEDED");
  });
});

describe("latency", () => {
  it("is DERIVED from the two instants, never accepted from a caller", () => {
    const started = beginCall(call(), AT);
    const done =
      started.ok && completeCall(started.value, { status: "SUCCEEDED", result: 1 }, new Date(AT.getTime() + 250));
    expect(done && done.ok && done.value.latencyMs).toBe(250);
  });

  it("is null for a call that was cancelled before it started", () => {
    const cancelled = completeCall(call(), { status: "CANCELLED", error: "abandoned" }, AT);
    expect(cancelled.ok && cancelled.value.latencyMs).toBeNull();
  });

  it("clamps rather than reporting a negative duration across a clock adjustment", () => {
    const started = beginCall(call(), AT);
    const done =
      started.ok && completeCall(started.value, { status: "SUCCEEDED", result: 1 }, new Date(AT.getTime() - 5_000));
    expect(done && done.ok && done.value.latencyMs).toBe(0);
  });
});

describe("completion", () => {
  it("clears the error on a success", () => {
    const started = beginCall(call({ error: "stale" }), AT);
    const done = started.ok && completeCall(started.value, { status: "SUCCEEDED", result: { ok: 1 } }, AT);
    expect(done && done.ok && done.value.error).toBeNull();
    expect(done && done.ok && done.value.result).toEqual({ ok: 1 });
  });

  it("clears the result on a failure, so no reader sees both", () => {
    const started = beginCall(call({ result: { partial: true } }), AT);
    const done = started.ok && completeCall(started.value, { status: "FAILED", error: "refused" }, AT);
    expect(done && done.ok && done.value.result).toBeNull();
    expect(done && done.ok && done.value.error).toBe("refused");
  });
});

describe("the transcript", () => {
  it("numbers a step's calls densely from zero", () => {
    expect(nextSequence([])).toBe(0);
    expect(nextSequence([call({ sequence: 0 }), call({ sequence: 1 })])).toBe(2);
  });

  it("refuses to reuse a position, which is the store's unique key", () => {
    const taken = admitSequence([call({ sequence: 0 })], STEP, 0);
    expect(!taken.ok && taken.error.code).toBe("TOOLS_CALL_SEQUENCE_CONFLICT");
    expect(admitSequence([call({ sequence: 0 })], STEP, 1).ok).toBe(true);
  });

  it("orders by sequence and NEVER by time, because a batch runs in parallel", () => {
    const later = call({ sequence: 0, startedAt: new Date(AT.getTime() + 900) });
    const earlier = call({ sequence: 1, startedAt: AT });
    expect(byTranscriptOrder(later, earlier)).toBeLessThan(0);
  });

  it("keeps a retry as a NEW entry that remembers its ancestry", () => {
    const failed = call({ status: "FAILED", error: "refused", retryCount: 1 });
    const retried = retryOf(failed, asToolsIdentifier<ToolCallId>("call-2"), 1, AT);
    expect(retried.retryCount).toBe(2);
    expect(retried.status).toBe("PENDING");
    expect(retried.error).toBeNull();
    expect(retried.arguments).toEqual(failed.arguments);
    expect(retried.sequence).not.toBe(failed.sequence);
  });
});
