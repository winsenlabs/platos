/**
 * Regression: tool results were emitted twice per call.
 *
 * The AI SDK reports a completed tool call through two channels — a
 * `tool-result` / `tool-error` stream chunk, and `onStepEnd`'s
 * `event.toolResults`, which lists EVERY result for the step including ones a
 * chunk already carried. The stream yielded both, so each result landed twice
 * in `PlatosAgentMessage.toolCalls` and twice in the history replayed to the
 * model on the next turn.
 *
 * Observed on test.platos before the fix: 1218 `call` events against 2376
 * `result` events, of which only 1202 were distinct — an exact 2x on 176 of
 * 211 tool-bearing messages, still reproducing on the day it was found.
 *
 * CLAUDE.md §9.11: Vitest only, no mocks. `claimToolResultEmission` is pure.
 */
import { describe, it, expect } from "vitest";
import { claimToolResultEmission } from "./agent.service";

describe("claimToolResultEmission", () => {
  it("admits a call ID once and refuses it thereafter", () => {
    const emitted = new Set<string>();
    expect(claimToolResultEmission("call_1", emitted)).toBe(true);
    expect(claimToolResultEmission("call_1", emitted)).toBe(false);
    expect(claimToolResultEmission("call_1", emitted)).toBe(false);
  });

  it("tracks distinct call IDs independently", () => {
    const emitted = new Set<string>();
    expect(claimToolResultEmission("call_1", emitted)).toBe(true);
    expect(claimToolResultEmission("call_2", emitted)).toBe(true);
    expect(claimToolResultEmission("call_1", emitted)).toBe(false);
    expect(claimToolResultEmission("call_2", emitted)).toBe(false);
  });

  it("always admits results with no call ID rather than dropping them", () => {
    const emitted = new Set<string>();
    // Uncorrelatable results must not be suppressed — losing a real result is
    // worse than a duplicate.
    expect(claimToolResultEmission(null, emitted)).toBe(true);
    expect(claimToolResultEmission(null, emitted)).toBe(true);
    expect(claimToolResultEmission(undefined, emitted)).toBe(true);
    expect(claimToolResultEmission("", emitted)).toBe(true);
    expect(emitted.size).toBe(0);
  });

  it("collapses the chunk-then-drain sequence to one emission per call", () => {
    // Models one step: two tools resolve, each surfacing first as a stream
    // chunk and again in onStepEnd's toolResults.
    const emitted = new Set<string>();
    const chunkResults = ["call_a", "call_b"];
    const stepEndResults = ["call_a", "call_b"];

    const yielded = [...chunkResults, ...stepEndResults].filter((callId) =>
      claimToolResultEmission(callId, emitted),
    );

    expect(yielded).toEqual(["call_a", "call_b"]);
  });

  it("still emits a step-attributed result that no chunk carried", () => {
    // Provider-executed calls arrive as chunks; client-executed ones may only
    // appear at step end. Both must reach the consumer exactly once.
    const emitted = new Set<string>();
    const yielded = ["call_provider", "call_provider", "call_client"].filter((callId) =>
      claimToolResultEmission(callId, emitted),
    );

    expect(yielded).toEqual(["call_provider", "call_client"]);
  });
});
