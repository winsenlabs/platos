// Forking, through the use case: what it writes, and what it refuses.
//
// Mutations M-FT1 (ownership), M-FT2 (writability), M-FT3 (the fan-out ceiling
// reaching the use case), M-FT4 (the outbox append inside the transaction).

import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentScope } from "@platos/kernel";

import { forkConversation } from "./fork-thread.js";
import {
  buildConversationsTestContext,
  END_USER_ID,
  runtimeGrant,
  THREAD_ID,
  threadFixture,
  turnFixture,
} from "./testing/index.js";
import { DEFAULT_CONVERSATIONS_POLICY, type EndUserId, type TurnId } from "../domain/index.js";

const SCOPE = {
  level: "environment",
  organizationId: "org-1",
  projectId: "proj-1",
  environmentId: "env-1",
} as EnvironmentScope;

function command(overrides: Record<string, unknown> = {}) {
  return {
    authorization: runtimeGrant(),
    scope: SCOPE,
    threadId: THREAD_ID,
    endUserId: END_USER_ID,
    forkedUpToTurnId: asIdentifier<TurnId>("turn-2"),
    ...overrides,
  } as Parameters<typeof forkConversation>[1];
}

function seedParent(context: ReturnType<typeof buildConversationsTestContext>): void {
  context.store.seedThread(threadFixture());
  context.store.seedTurn(turnFixture({ turnId: asIdentifier<TurnId>("turn-1"), sequence: 1 }));
  context.store.seedTurn(turnFixture({ turnId: asIdentifier<TurnId>("turn-2"), sequence: 2 }));
  context.store.seedTurn(turnFixture({ turnId: asIdentifier<TurnId>("turn-3"), sequence: 3 }));
}

describe("forkConversation", () => {
  it("writes ONE row and copies no turn, no step and no ledger row", async () => {
    const context = buildConversationsTestContext();
    seedParent(context);
    const turnsBefore = context.store.turns.size;

    const forked = await forkConversation(context.dependencies, command());
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    expect(forked.value.parentThreadId).toBe(THREAD_ID);
    expect(forked.value.forkedUpToTurnId).toBe("turn-2");
    expect(forked.value.forkedTurnIds).toEqual(["turn-1", "turn-2"]);
    // Copying them would duplicate billable ledger rows, which the schema
    // comment on `forkedTurnIds` says in as many words.
    expect(context.store.turns.size).toBe(turnsBefore);
    expect(context.store.threads.size).toBe(2);
  });

  it("inherits the parent's agent and end user, with no way to change either", async () => {
    const context = buildConversationsTestContext();
    seedParent(context);
    const forked = await forkConversation(context.dependencies, command());
    if (!forked.ok) throw new Error(forked.error.code);
    expect(forked.value.agentId).toBe("agent-1");
    expect(forked.value.endUserId).toBe(END_USER_ID);
    expect(Object.keys(command())).not.toContain("agentId");
  });

  it("emits `conversations.thread.forked` inside the same transaction", async () => {
    const context = buildConversationsTestContext();
    seedParent(context);
    await forkConversation(context.dependencies, command());
    expect(context.outbox.names()).toEqual(["conversations.thread.forked"]);
    const payload = context.outbox.appended[0]?.payload as Record<string, unknown>;
    expect(payload.inheritedTurnCount).toBe(2);
    expect(payload.depth).toBe(1);
    expect(context.outbox.appended[0]?.transactionId).toBe("txn-1");
  });

  it("refuses when the caller is NOT the thread's end user", async () => {
    const context = buildConversationsTestContext();
    seedParent(context);
    const refused = await forkConversation(
      context.dependencies,
      command({ endUserId: asIdentifier<EndUserId>("end-user-2") }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_THREAD_NOT_FOUND");
    expect(context.store.threads.size).toBe(1);
  });

  it("refuses to fork an ARCHIVED thread", async () => {
    const context = buildConversationsTestContext();
    seedParent(context);
    context.store.seedThread(threadFixture({ archivedAt: new Date() }));
    const refused = await forkConversation(context.dependencies, command());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_THREAD_ARCHIVED");
  });

  it("refuses a boundary turn that is not in the parent thread", async () => {
    const context = buildConversationsTestContext();
    seedParent(context);
    const refused = await forkConversation(
      context.dependencies,
      command({ forkedUpToTurnId: asIdentifier<TurnId>("turn-from-elsewhere") }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_FORK_TURN_FOREIGN");
    expect(context.outbox.appended).toHaveLength(0);
  });

  it("refuses at the FAN-OUT ceiling, counting the forks the store already holds", async () => {
    const context = buildConversationsTestContext({
      ...DEFAULT_CONVERSATIONS_POLICY,
      thread: { ...DEFAULT_CONVERSATIONS_POLICY.thread, maxForksPerThread: 1 },
    });
    seedParent(context);

    const first = await forkConversation(context.dependencies, command());
    expect(first.ok).toBe(true);
    const second = await forkConversation(context.dependencies, command());
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("CONVERSATIONS_FORK_CEILING_EXCEEDED");
  });

  it("refuses at the DEPTH ceiling with a different code from the fan-out one", async () => {
    const context = buildConversationsTestContext({
      ...DEFAULT_CONVERSATIONS_POLICY,
      thread: { ...DEFAULT_CONVERSATIONS_POLICY.thread, maxForkDepth: 1 },
    });
    seedParent(context);

    const first = await forkConversation(context.dependencies, command());
    if (!first.ok) throw new Error(first.error.code);
    context.store.seedTurn(
      turnFixture({
        turnId: asIdentifier<TurnId>("turn-4"),
        threadId: first.value.threadId,
        sequence: 1,
      }),
    );
    const second = await forkConversation(
      context.dependencies,
      command({
        threadId: first.value.threadId,
        forkedUpToTurnId: asIdentifier<TurnId>("turn-4"),
      }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("CONVERSATIONS_FORK_DEPTH_EXCEEDED");
  });
});
