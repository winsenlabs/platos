// The published surface: what a composition root can reach, and what it cannot.
//
// Mutations M-B1 (drop a method from the binder), M-B2 (unfreeze the contract),
// M-B3 (drop `erasureTarget` — also covered from the other side in
// `application/conversations-erasure-target.test.ts`).

import { describe, expect, it } from "vitest";

import * as published from "./index.js";
import { createConversationsContract } from "./index.js";
import { buildConversationsTestContext } from "../application/testing/index.js";

function contract() {
  return createConversationsContract(buildConversationsTestContext().dependencies);
}

describe("the binder", () => {
  it("names this context", () => {
    expect(contract().name).toBe("conversations");
  });

  it("is FROZEN, so a transport cannot patch behaviour onto it", () => {
    const bound = contract();
    expect(Object.isFrozen(bound)).toBe(true);
    expect(() => {
      (bound as unknown as Record<string, unknown>).extra = () => undefined;
    }).toThrow();
  });

  it("publishes every use case a transport needs, and each is callable", () => {
    const bound = contract();
    const methods = [
      "openThread",
      "describeThread",
      "forkThread",
      "inspectThread",
      "pageThreads",
      "pageTurns",
      "describeTurn",
      "runTurn",
      "planCompaction",
      "completeCompaction",
      "launchExecution",
      "settleExecution",
      "describeExecution",
      "erasureTarget",
    ] as const;
    for (const method of methods) expect(typeof bound[method]).toBe("function");
    expect(Object.keys(bound)).toHaveLength(methods.length + 1);
  });

  it("publishes the ErasureTarget as a STABLE instance", () => {
    const bound = contract();
    const target = bound.erasureTarget();
    expect(target.targetName).toBe("conversations");
    expect(bound.erasureTarget()).toBe(target);
  });
});

describe("the vocabulary the barrel carries", () => {
  it("publishes the event names, which are how anything learns about a turn", () => {
    expect([...published.CONVERSATIONS_EVENT_NAMES]).toContain("conversations.turn.settled");
    expect([...published.CONVERSATIONS_EVENT_NAMES]).toContain("conversations.turn.failed");
    expect([...published.CONVERSATIONS_EVENT_NAMES]).toContain("conversations.thread.compacted");
  });

  it("publishes the error codes, so a transport builds its status table from one list", () => {
    expect(published.CONVERSATIONS_ERROR_CODES.length).toBeGreaterThan(0);
    expect([...published.CONVERSATIONS_ERROR_CODES]).toContain("CONVERSATIONS_TURNS_DISABLED");
  });

  it("publishes the four status and bucket vocabularies as frozen arrays", () => {
    for (const vocabulary of [
      published.WORK_STATUSES,
      published.TERMINAL_WORK_STATUSES,
      published.THREAD_COMPACTION_STATES,
      published.VERSION_BUCKETS,
      published.STEP_RATE_NAMES,
      published.RATE_SOURCES,
    ]) {
      expect(Array.isArray(vocabulary)).toBe(true);
      expect(vocabulary.length).toBeGreaterThan(0);
    }
  });

  it("publishes the shipped policy, so a root can move a ceiling without reaching in", () => {
    expect(published.DEFAULT_CONVERSATIONS_POLICY.turn.turnsEnabled).toBe(true);
    expect(published.DEFAULT_CONVERSATIONS_POLICY.subAgent.maxDepth).toBe(2);
    expect(Object.isFrozen(published.DEFAULT_CONVERSATIONS_POLICY)).toBe(true);
  });

  it("publishes the meta-tool ownership map as data, not as prose", () => {
    expect(published.META_TOOL_OWNERS.remember).toBe("memory");
    expect(published.META_TOOL_OWNERS.spawn_job).toBe("jobs");
    expect(published.META_TOOL_OWNERS.spawn_agent).toBeUndefined();
  });

  it("names the primary step sequence, so a reader is not left guessing at a bare 1", () => {
    expect(published.PRIMARY_STEP_SEQUENCE).toBe(1);
  });
});

describe("what the barrel deliberately WITHHOLDS", () => {
  it("carries no store, no framework and no inference client", () => {
    for (const [name, value] of Object.entries(published)) {
      if (typeof value !== "function") continue;
      expect(name).not.toMatch(/prisma|nest|openai|anthropic/iu);
    }
  });

  it("exports no driven port: those are adapter-facing and live on the other subpath", () => {
    expect(published).not.toHaveProperty("ThreadRepository");
    expect(published).not.toHaveProperty("TurnRepository");
    expect(published).not.toHaveProperty("ConversationsErasureStore");
  });

  it("exports no cost-ledger writer: the event carries the cost and nothing calls back", () => {
    expect(published).not.toHaveProperty("recordTurn");
    expect(published).not.toHaveProperty("recordUsage");
  });
});
