import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { AgentId, EndUserId, ThreadId } from "./identifiers.js";
import {
  attachmentScope,
  sameAttachmentScope,
  sameEnvironment,
  sameThreadScope,
  threadPath,
  threadScope,
  toThreadScope,
  type ThreadScope,
} from "./scope.js";

function thread(environmentId: string, threadId = "thread-1"): ThreadScope {
  return threadScope(
    environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier(environmentId)),
    asIdentifier<ThreadId>(threadId),
  );
}

const OWNER = { endUserId: asIdentifier<EndUserId>("eu-1"), agentId: asIdentifier<AgentId>("ag-1") };

describe("threadPath", () => {
  it("extends the kernel's resolvePath rather than inventing a second key format", () => {
    expect(threadPath(thread("env-1"))).toBe("org/org-1/proj/proj-1/env/env-1/thread/thread-1");
  });
});

describe("scope predicates", () => {
  it("distinguishes thread identity from environment identity", () => {
    const here = thread("env-1", "thread-1");
    const sibling = thread("env-1", "thread-2");
    const elsewhere = thread("env-2", "thread-1");

    expect(sameThreadScope(here, thread("env-1", "thread-1"))).toBe(true);
    expect(sameThreadScope(here, sibling)).toBe(false);
    expect(sameEnvironment(here, sibling)).toBe(true);
    expect(sameEnvironment(here, elsewhere)).toBe(false);
  });

  it("treats the owner columns as part of an attachment's scope", () => {
    const base = thread("env-1");
    const mine = attachmentScope(base, OWNER);
    expect(sameAttachmentScope(mine, attachmentScope(base, OWNER))).toBe(true);
    expect(
      sameAttachmentScope(mine, attachmentScope(base, { ...OWNER, endUserId: asIdentifier<EndUserId>("eu-2") })),
    ).toBe(false);
    expect(
      sameAttachmentScope(mine, attachmentScope(base, { ...OWNER, agentId: asIdentifier<AgentId>("ag-2") })),
    ).toBe(false);
  });

  it("widens an attachment scope to the thread scope both aggregates share", () => {
    const widened = toThreadScope(attachmentScope(thread("env-1"), OWNER));
    expect(sameThreadScope(widened, thread("env-1"))).toBe(true);
    expect("owner" in widened).toBe(false);
  });
});
