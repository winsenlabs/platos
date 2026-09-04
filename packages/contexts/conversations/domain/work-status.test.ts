// The transition table, which is the rule Prisma cannot express.
//
// The enum lets any of the five statuses sit in any of the three columns. What
// it cannot say is that SUCCEEDED, FAILED and CANCELLED are TERMINAL — and that
// is the whole of what goes wrong in the extraction source, where a
// late-arriving stream close patches an errored turn to SUCCEEDED and a retry
// re-opens a cancelled one.
//
// Mutation M-W1: replace `if (!canTransition(from, to)) return err(...)` with
// `return ok(to)`. Every "refuses" case below goes red.

import { describe, expect, it } from "vitest";

import {
  canTransition,
  isTerminal,
  isWorkStatus,
  TERMINAL_WORK_STATUSES,
  transition,
  WORK_STATUSES,
  type WorkStatus,
} from "./work-status.js";

describe("the vocabulary", () => {
  it("is the five the canonical enum declares, in its order", () => {
    expect([...WORK_STATUSES]).toEqual(["PENDING", "ACTIVE", "SUCCEEDED", "FAILED", "CANCELLED"]);
  });

  it("names exactly three of them terminal", () => {
    expect([...TERMINAL_WORK_STATUSES]).toEqual(["SUCCEEDED", "FAILED", "CANCELLED"]);
    for (const status of TERMINAL_WORK_STATUSES) expect(isTerminal(status)).toBe(true);
    expect(isTerminal("PENDING")).toBe(false);
    expect(isTerminal("ACTIVE")).toBe(false);
  });

  it("rejects a status outside the enum", () => {
    expect(isWorkStatus("ARCHIVED")).toBe(false);
    expect(isWorkStatus("COMPLETED")).toBe(false);
    expect(isWorkStatus("SUCCEEDED")).toBe(true);
  });
});

describe("canTransition", () => {
  it("lets PENDING become ACTIVE, and also settle without ever running", () => {
    expect(canTransition("PENDING", "ACTIVE")).toBe(true);
    expect(canTransition("PENDING", "CANCELLED")).toBe(true);
    expect(canTransition("PENDING", "FAILED")).toBe(true);
    expect(canTransition("PENDING", "SUCCEEDED")).toBe(true);
  });

  it("lets ACTIVE settle three ways and never go back to PENDING", () => {
    expect(canTransition("ACTIVE", "SUCCEEDED")).toBe(true);
    expect(canTransition("ACTIVE", "FAILED")).toBe(true);
    expect(canTransition("ACTIVE", "CANCELLED")).toBe(true);
    expect(canTransition("ACTIVE", "PENDING")).toBe(false);
  });

  it("lets NOTHING leave a terminal status — all fifteen pairs refuse", () => {
    for (const from of TERMINAL_WORK_STATUSES) {
      for (const to of WORK_STATUSES) {
        expect(canTransition(from, to as WorkStatus)).toBe(false);
      }
    }
  });
});

describe("transition", () => {
  it("moves an open row and answers the new status", () => {
    const moved = transition("turn-1", "ACTIVE", "SUCCEEDED");
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value).toBe("SUCCEEDED");
  });

  it("refuses a second settlement and names the status that closed it first", () => {
    const refused = transition("turn-1", "FAILED", "SUCCEEDED");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_TURN_ALREADY_SETTLED");
    expect(refused.error.details.status).toBe("FAILED");
    expect(refused.error.details.turnId).toBe("turn-1");
  });

  it("refuses re-opening a cancelled row, which a retry would otherwise do", () => {
    const refused = transition("turn-1", "CANCELLED", "ACTIVE");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details.status).toBe("CANCELLED");
  });
});
