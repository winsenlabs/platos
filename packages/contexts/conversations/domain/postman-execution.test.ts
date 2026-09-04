// The postman execution: an expiry the source never checks, and a replay it
// cannot tell from a collision.
//
// Mutations M-E1 (the handle expiry), M-E2 (the fingerprint comparison), M-E3
// (settle twice).

import { describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import {
  openPostmanExecution,
  reconcileReplay,
  requireLiveHandle,
  settlePostmanExecution,
} from "./postman-execution.js";
import type {
  ActorId,
  AgentId,
  EndUserId,
  PostmanContextHandle,
  PostmanExecutionId,
  PostmanTemplateId,
  ThreadId,
  TurnId,
} from "./identifiers.js";

const AT = new Date("2026-01-01T00:00:00.000Z");
const EXPIRES = new Date("2026-01-01T00:15:00.000Z");

function execution(overrides: Record<string, unknown> = {}) {
  return openPostmanExecution({
    executionId: asIdentifier<PostmanExecutionId>("exec-1"),
    agentId: asIdentifier<AgentId>("agent-1"),
    templateId: asIdentifier<PostmanTemplateId>("template-1"),
    requestId: "request-1",
    requestFingerprint: "sha:aaa",
    actorUserId: asIdentifier<ActorId>("operator-1"),
    simulatedEndUserId: asIdentifier<EndUserId>("end-user-1"),
    contextHandle: asIdentifier<PostmanContextHandle>("handle-1"),
    contextExpiresAt: EXPIRES,
    at: AT,
    ...overrides,
  });
}

describe("openPostmanExecution", () => {
  it("starts PENDING with no thread and no turn bound to it yet", () => {
    const opened = execution();
    expect(opened.status).toBe("PENDING");
    expect(opened.threadId).toBeNull();
    expect(opened.turnId).toBeNull();
    expect(opened.completedAt).toBeNull();
  });

  it("records BOTH the operator who acted and the end user they simulated", () => {
    const opened = execution();
    expect(opened.actorUserId).toBe("operator-1");
    expect(opened.simulatedEndUserId).toBe("end-user-1");
  });
});

describe("requireLiveHandle", () => {
  it("admits a handle before its deadline", () => {
    const live = requireLiveHandle(execution(), new Date("2026-01-01T00:14:59.999Z"));
    expect(live.ok).toBe(true);
  });

  it("refuses a handle AT its deadline, and after it", () => {
    // The source writes both columns and checks neither, so a handle minted a
    // month ago still names its execution.
    const atDeadline = requireLiveHandle(execution(), EXPIRES);
    expect(atDeadline.ok).toBe(false);
    if (atDeadline.ok) return;
    expect(atDeadline.error.code).toBe("CONVERSATIONS_POSTMAN_HANDLE_EXPIRED");
    expect(atDeadline.error.details.expiredAt).toBe(EXPIRES.toISOString());

    const after = requireLiveHandle(execution(), new Date("2026-02-01T00:00:00.000Z"));
    expect(after.ok).toBe(false);
  });

  it("answers the SAME execution, so a caller cannot check one and act on another", () => {
    const one = execution();
    const live = requireLiveHandle(one, AT);
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(live.value).toBe(one);
  });
});

describe("reconcileReplay", () => {
  it("answers the existing execution when the fingerprint MATCHES — a retry", () => {
    const one = execution();
    const replayed = reconcileReplay(one, "sha:aaa");
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value).toBe(one);
  });

  it("REFUSES a differing fingerprint, because answering it hands over another's result", () => {
    const refused = reconcileReplay(execution(), "sha:bbb");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // `@@unique([templateId, requestId])` cannot see this: both rows would
    // collide identically, and the first execution would be handed back.
    expect(refused.error.code).toBe("CONVERSATIONS_POSTMAN_FINGERPRINT_MISMATCH");
    expect(refused.error.details.requestId).toBe("request-1");
  });
});

describe("settlePostmanExecution", () => {
  it("binds the thread and the turn and closes the execution", () => {
    const settled = settlePostmanExecution(execution(), {
      status: "SUCCEEDED",
      threadId: asIdentifier<ThreadId>("thread-1"),
      turnId: asIdentifier<TurnId>("turn-1"),
      at: EXPIRES,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.status).toBe("SUCCEEDED");
    expect(settled.value.threadId).toBe("thread-1");
    expect(settled.value.turnId).toBe("turn-1");
    expect(settled.value.completedAt).toEqual(EXPIRES);
  });

  it("refuses a SECOND settlement with its own code", () => {
    const first = settlePostmanExecution(execution(), {
      status: "SUCCEEDED",
      threadId: asIdentifier<ThreadId>("thread-1"),
      turnId: asIdentifier<TurnId>("turn-1"),
      at: EXPIRES,
    });
    if (!first.ok) throw new Error(first.error.code);
    const second = settlePostmanExecution(first.value, {
      status: "FAILED",
      threadId: asIdentifier<ThreadId>("thread-2"),
      turnId: asIdentifier<TurnId>("turn-2"),
      at: EXPIRES,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("CONVERSATIONS_POSTMAN_ALREADY_SETTLED");
    expect(second.error.details.status).toBe("SUCCEEDED");
  });
});
