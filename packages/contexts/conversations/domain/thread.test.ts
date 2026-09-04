// Admitting a thread, and the four ceilings a column type cannot state.
//
// Mutations M-T1..M-T5 each delete one guard below; each turns a named case red.

import { describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import { DEFAULT_CONVERSATIONS_POLICY } from "./policy.js";
import {
  admitSessionContext,
  isOwnedBy,
  openThread,
  requireWritable,
  type SessionContext,
} from "./thread.js";
import type { AgentId, EndUserId, ThreadId } from "./identifiers.js";

const POLICY = DEFAULT_CONVERSATIONS_POLICY.thread;
const AT = new Date("2026-01-01T00:00:00.000Z");

function draft(overrides: Record<string, unknown> = {}) {
  return {
    threadId: asIdentifier<ThreadId>("thread-1"),
    agentId: asIdentifier<AgentId>("agent-1"),
    endUserId: asIdentifier<EndUserId>("end-user-1"),
    at: AT,
    ...overrides,
  } as Parameters<typeof openThread>[0];
}

describe("openThread", () => {
  it("opens ACTIVE, IDLE, unpinned, unarchived, with no fork ancestry", () => {
    const opened = openThread(draft(), POLICY);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.status).toBe("ACTIVE");
    expect(opened.value.compactionState).toBe("IDLE");
    expect(opened.value.pinnedAt).toBeNull();
    expect(opened.value.archivedAt).toBeNull();
    expect(opened.value.parentThreadId).toBeNull();
    expect(opened.value.forkedTurnIds).toEqual([]);
    expect(opened.value.createdAt).toEqual(AT);
  });

  it("trims a title and keeps it", () => {
    const opened = openThread(draft({ title: "  a name  " }), POLICY);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.title).toBe("a name");
  });

  it("refuses a blank title, distinguishing it from an absent one", () => {
    const absent = openThread(draft({ title: null }), POLICY);
    expect(absent.ok).toBe(true);
    const blank = openThread(draft({ title: "   " }), POLICY);
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.error.code).toBe("CONVERSATIONS_THREAD_TITLE_INVALID");
    expect(blank.error.fields[0]?.code).toBe("BLANK");
  });

  it("refuses a title one character over the ceiling", () => {
    const refused = openThread(draft({ title: "x".repeat(POLICY.maxTitleLength + 1) }), POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.fields[0]?.code).toBe("TOO_LONG");
    const admitted = openThread(draft({ title: "x".repeat(POLICY.maxTitleLength) }), POLICY);
    expect(admitted.ok).toBe(true);
  });

  it("refuses one tag over the ceiling and admits exactly the ceiling", () => {
    const tags = (count: number) => Array.from({ length: count }, (_, index) => `tag-${index}`);
    expect(openThread(draft({ tags: tags(POLICY.maxTags) }), POLICY).ok).toBe(true);
    const refused = openThread(draft({ tags: tags(POLICY.maxTags + 1) }), POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_THREAD_TAGS_INVALID");
    expect(refused.error.fields[0]?.code).toBe("TOO_MANY");
  });

  it("refuses a blank tag and names its index", () => {
    const refused = openThread(draft({ tags: ["ok", "  "] }), POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.fields[0]?.field).toBe("tags[1]");
    expect(refused.error.fields[0]?.code).toBe("BLANK");
  });

  it("refuses an over-long tag and names its index", () => {
    const refused = openThread(
      draft({ tags: ["ok", "y".repeat(POLICY.maxTagLength + 1)] }),
      POLICY,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.fields[0]?.field).toBe("tags[1]");
    expect(refused.error.fields[0]?.code).toBe("TOO_LONG");
  });
});

describe("admitSessionContext", () => {
  it("admits an object root and freezes a copy of it", () => {
    const admitted = admitSessionContext({ channel: "slack" } as SessionContext, POLICY);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value).toEqual({ channel: "slack" });
    expect(Object.isFrozen(admitted.value)).toBe(true);
  });

  it("admits absence as null rather than as an empty object", () => {
    const admitted = admitSessionContext(null, POLICY);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value).toBeNull();
  });

  it("refuses an ARRAY root, which the column's own registry cannot validate", () => {
    const refused = admitSessionContext([] as unknown as SessionContext, POLICY);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_SESSION_CONTEXT_INVALID");
  });

  it("refuses a SCALAR root with the same code, and a huge object with a DIFFERENT one", () => {
    const scalar = admitSessionContext("nope" as unknown as SessionContext, POLICY);
    expect(scalar.ok).toBe(false);
    if (scalar.ok) return;
    expect(scalar.error.code).toBe("CONVERSATIONS_SESSION_CONTEXT_INVALID");

    const huge = admitSessionContext(
      { blob: "z".repeat(POLICY.maxSessionContextBytes + 1) } as SessionContext,
      POLICY,
    );
    expect(huge.ok).toBe(false);
    if (huge.ok) return;
    // Two decisions, two codes: a shape nobody can read, and a shape that is fine
    // and simply too big for every prompt this thread will ever build.
    expect(huge.error.code).toBe("CONVERSATIONS_SESSION_CONTEXT_TOO_LARGE");
    expect(huge.error.details.maximum).toBe(POLICY.maxSessionContextBytes);
  });
});

describe("requireWritable", () => {
  it("admits a live thread and answers it unchanged", () => {
    const opened = openThread(draft(), POLICY);
    if (!opened.ok) throw new Error(opened.error.code);
    const writable = requireWritable(opened.value);
    expect(writable.ok).toBe(true);
    if (!writable.ok) return;
    expect(writable.value).toBe(opened.value);
  });

  it("refuses an ARCHIVED thread with its own code, not the settled one", () => {
    const opened = openThread(draft(), POLICY);
    if (!opened.ok) throw new Error(opened.error.code);
    const refused = requireWritable({ ...opened.value, archivedAt: AT });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_THREAD_ARCHIVED");
    expect(refused.error.category).toBe("precondition_failed");
  });
});

describe("isOwnedBy", () => {
  it("is true only for the thread's own end user", () => {
    const opened = openThread(draft(), POLICY);
    if (!opened.ok) throw new Error(opened.error.code);
    expect(isOwnedBy(opened.value, asIdentifier<EndUserId>("end-user-1"))).toBe(true);
    expect(isOwnedBy(opened.value, asIdentifier<EndUserId>("end-user-2"))).toBe(false);
  });
});
