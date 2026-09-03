import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  clampTimeoutSeconds,
  deadlineOf,
  effectiveArguments,
  hasElapsed,
  isPending,
  isResolved,
  isSweepable,
  requireEdit,
  resolveApproval,
  secondsRemaining,
  timeOutApproval,
  type Approval,
  APPROVAL_TIMEOUT_DEFAULT_SECONDS,
  APPROVAL_TIMEOUT_FLOOR_SECONDS,
  MCP_APPROVAL_TIMEOUT_DEFAULT_SECONDS,
  MCP_APPROVAL_TIMEOUT_FLOOR_SECONDS,
} from "./approval.js";
import type { ApprovalId, ApprovalRowId } from "./identifiers.js";

const CREATED = new Date("2026-01-01T00:00:00.000Z");

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    rowId: asIdentifier<ApprovalRowId>("row-1"),
    approvalId: asIdentifier<ApprovalId>("appr-1"),
    source: "request_approval",
    agentId: null,
    threadId: null,
    turnId: null,
    action: "Delete everything",
    details: null,
    toolName: null,
    arguments: { path: "/tmp" },
    requestedBy: "user-1",
    requestDigest: null,
    requestedByTokenId: null,
    status: "pending",
    timeoutSeconds: 300,
    createdAt: CREATED,
    updatedAt: CREATED,
    resolution: null,
    consumedAt: null,
    outcome: null,
    ...overrides,
  };
}

/** `createdAt + timeoutSeconds`, as a Date, for readable assertions. */
function at(offsetMs: number): Date {
  return new Date(CREATED.getTime() + offsetMs);
}

describe("deadline", () => {
  it("is createdAt plus timeoutSeconds", () => {
    expect(deadlineOf(approval({ timeoutSeconds: 90 }))).toEqual(at(90_000));
  });
});

describe("the two expiry predicates diverge at exactly the deadline", () => {
  // This is the live divergence `domain/approval.ts` documents. It is PINNED, so
  // a future unification is a deliberate act that fails here first.
  const pending = approval({ timeoutSeconds: 300 });
  const deadlineMs = 300_000;

  it("both say NOT expired one millisecond before the deadline", () => {
    expect(hasElapsed(pending, at(deadlineMs - 1))).toBe(false);
    expect(isSweepable(pending, at(deadlineMs - 1))).toBe(false);
  });

  it("DISAGREE at exactly the deadline: the read path says expired, the sweep does not", () => {
    expect(hasElapsed(pending, at(deadlineMs))).toBe(true);
    expect(isSweepable(pending, at(deadlineMs))).toBe(false);
  });

  it("both say expired one millisecond after the deadline", () => {
    expect(hasElapsed(pending, at(deadlineMs + 1))).toBe(true);
    expect(isSweepable(pending, at(deadlineMs + 1))).toBe(true);
  });

  it("neither applies to an already-decided approval", () => {
    const decided = approval({ status: "approved" });
    expect(hasElapsed(decided, at(deadlineMs + 10_000))).toBe(false);
    expect(isSweepable(decided, at(deadlineMs + 10_000))).toBe(false);
  });
});

describe("secondsRemaining", () => {
  it("floors toward zero", () => {
    expect(secondsRemaining(approval({ timeoutSeconds: 10 }), at(1_500))).toBe(8);
  });

  it("is null once the read-path predicate says elapsed", () => {
    expect(secondsRemaining(approval({ timeoutSeconds: 10 }), at(10_000))).toBeNull();
  });

  it("is null for a decided approval", () => {
    expect(secondsRemaining(approval({ status: "rejected" }), at(0))).toBeNull();
  });
});

describe("clampTimeoutSeconds", () => {
  it("applies the generic floor and default", () => {
    expect(clampTimeoutSeconds(null, APPROVAL_TIMEOUT_FLOOR_SECONDS, APPROVAL_TIMEOUT_DEFAULT_SECONDS)).toBe(300);
    expect(clampTimeoutSeconds(0, APPROVAL_TIMEOUT_FLOOR_SECONDS, APPROVAL_TIMEOUT_DEFAULT_SECONDS)).toBe(1);
  });

  it("applies the MCP path's HIGHER floor and LONGER default", () => {
    expect(
      clampTimeoutSeconds(undefined, MCP_APPROVAL_TIMEOUT_FLOOR_SECONDS, MCP_APPROVAL_TIMEOUT_DEFAULT_SECONDS),
    ).toBe(3600);
    expect(clampTimeoutSeconds(5, MCP_APPROVAL_TIMEOUT_FLOOR_SECONDS, MCP_APPROVAL_TIMEOUT_DEFAULT_SECONDS)).toBe(60);
  });

  it("rounds before clamping", () => {
    expect(clampTimeoutSeconds(120.4, 1, 300)).toBe(120);
    expect(clampTimeoutSeconds(120.6, 1, 300)).toBe(121);
  });
});

describe("resolveApproval", () => {
  const decidedAt = at(1_000);

  it("records the decision, who made it, and when", () => {
    const decided = resolveApproval(approval(), "approved", decidedAt, {
      respondedBy: "operator-1",
      comment: "looks fine",
    });
    if (!decided.ok) throw new Error("unreachable");
    expect(decided.value.status).toBe("approved");
    expect(decided.value.resolution).toMatchObject({
      status: "approved",
      respondedBy: "operator-1",
      comment: "looks fine",
      resolvedAt: decidedAt,
    });
    expect(isResolved(decided.value)).toBe(true);
    expect(isPending(decided.value)).toBe(false);
  });

  it("REFUSES a second decision", () => {
    const first = resolveApproval(approval(), "approved", decidedAt);
    if (!first.ok) throw new Error("unreachable");
    const second = resolveApproval(first.value, "rejected", decidedAt);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.error.code).toBe("JOBS_APPROVAL_ALREADY_RESOLVED");
    expect(second.error.category).toBe("conflict");
  });

  it("keeps edits on an APPROVAL", () => {
    const decided = resolveApproval(approval(), "approved", decidedAt, {
      edit: { editedArguments: { path: "/safe" }, editedBy: "operator-1" },
    });
    if (!decided.ok) throw new Error("unreachable");
    expect(decided.value.resolution?.edit).toEqual({
      editedArguments: { path: "/safe" },
      editedBy: "operator-1",
    });
  });

  it("DISCARDS edits on a rejection — no work follows a refusal", () => {
    const decided = resolveApproval(approval(), "rejected", decidedAt, {
      edit: { editedArguments: { path: "/safe" }, editedBy: "operator-1" },
    });
    if (!decided.ok) throw new Error("unreachable");
    expect(decided.value.resolution?.edit).toBeNull();
  });

  it("DISCARDS edits on a timeout", () => {
    const decided = resolveApproval(approval(), "timed_out", decidedAt, {
      edit: { editedArguments: { path: "/safe" }, editedBy: null },
    });
    if (!decided.ok) throw new Error("unreachable");
    expect(decided.value.resolution?.edit).toBeNull();
  });
});

describe("effectiveArguments", () => {
  it("returns the originals when nothing was edited", () => {
    const decided = resolveApproval(approval(), "approved", at(1));
    if (!decided.ok) throw new Error("unreachable");
    expect(effectiveArguments(decided.value)).toEqual({ path: "/tmp" });
  });

  it("returns the EDITS when a human changed them", () => {
    const decided = resolveApproval(approval(), "approved", at(1), {
      edit: { editedArguments: { path: "/safe" }, editedBy: "operator-1" },
    });
    if (!decided.ok) throw new Error("unreachable");
    expect(effectiveArguments(decided.value)).toEqual({ path: "/safe" });
  });
});

describe("requireEdit", () => {
  it("refuses an approved-with-edits decision whose edits are absent", () => {
    const required = requireEdit("approved", { editedArguments: null, editedBy: null });
    expect(required.ok).toBe(false);
    if (required.ok) throw new Error("unreachable");
    expect(required.error.code).toBe("JOBS_APPROVAL_EDIT_MISSING");
  });

  it("permits an approval with no edits at all", () => {
    expect(requireEdit("approved", null).ok).toBe(true);
  });
});

describe("timeOutApproval", () => {
  it("moves a pending approval to timed_out", () => {
    const expired = timeOutApproval(approval(), at(400_000));
    if (!expired.ok) throw new Error("unreachable");
    expect(expired.value.status).toBe("timed_out");
  });

  it("REFUSES to time out an already-decided approval", () => {
    expect(timeOutApproval(approval({ status: "approved" }), at(400_000)).ok).toBe(false);
  });
});
