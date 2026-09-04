// Reads: the page ceiling the source does not have, and two callers who must
// see different refusals.
//
// Mutations M-M1 (the limit ceiling), M-M2 (the offset check), M-M3 (resolving
// the thread before paging its turns), M-M4 (the operator grant on the pages).

import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentScope } from "@platos/kernel";

import {
  admitPage,
  describeConversation,
  describeConversationTurn,
  inspectConversation,
  openConversation,
  pageConversationTurns,
  pageConversations,
} from "./manage-threads.js";
import {
  AGENT_ID,
  buildConversationsTestContext,
  END_USER_ID,
  runtimeGrant,
  stepFixture,
  THREAD_ID,
  threadFixture,
  turnFixture,
} from "./testing/index.js";
import { DEFAULT_CONVERSATIONS_POLICY, type EndUserId, type ThreadId, type TurnId } from "../domain/index.js";

const SCOPE = {
  level: "environment",
  organizationId: "org-1",
  projectId: "proj-1",
  environmentId: "env-1",
} as EnvironmentScope;

const CEILING = DEFAULT_CONVERSATIONS_POLICY.thread.maxPageSize;

describe("openConversation", () => {
  it("creates the thread and emits `conversations.thread.opened` in one transaction", async () => {
    const context = buildConversationsTestContext();
    const opened = await openConversation(context.dependencies, {
      authorization: runtimeGrant(),
      scope: SCOPE,
      agentId: AGENT_ID,
      endUserId: END_USER_ID,
      title: "a conversation",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.title).toBe("a conversation");
    expect(context.store.threads.size).toBe(1);
    expect(context.outbox.names()).toEqual(["conversations.thread.opened"]);
    expect(context.unitOfWork.transactions).toBe(1);
  });

  it("refuses a grant for another scope, and writes nothing", async () => {
    const context = buildConversationsTestContext();
    const refused = await openConversation(context.dependencies, {
      authorization: runtimeGrant({ ...SCOPE, environmentId: "env-2" } as EnvironmentScope),
      scope: SCOPE,
      agentId: AGENT_ID,
      endUserId: END_USER_ID,
    });
    expect(refused.ok).toBe(false);
    expect(context.store.threads.size).toBe(0);
    expect(context.outbox.appended).toHaveLength(0);
  });

  it("refuses an unusable title before it opens a transaction", async () => {
    const context = buildConversationsTestContext();
    const refused = await openConversation(context.dependencies, {
      authorization: runtimeGrant(),
      scope: SCOPE,
      agentId: AGENT_ID,
      endUserId: END_USER_ID,
      title: "   ",
    });
    expect(refused.ok).toBe(false);
    expect(context.unitOfWork.transactions).toBe(0);
  });
});

describe("the two reads", () => {
  it("shows an end user their own thread and HIDES another's as not_found", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());

    const own = await describeConversation(context.dependencies, {
      authorization: runtimeGrant(),
      scope: SCOPE,
      threadId: THREAD_ID,
      endUserId: END_USER_ID,
    });
    expect(own.ok).toBe(true);

    const other = await describeConversation(context.dependencies, {
      authorization: runtimeGrant(),
      scope: SCOPE,
      threadId: THREAD_ID,
      endUserId: asIdentifier<EndUserId>("end-user-2"),
    });
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.error.code).toBe("CONVERSATIONS_THREAD_NOT_FOUND");
  });

  it("tells an OPERATOR that the same thread exists and is somebody else's", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    const seen = await inspectConversation(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      threadId: THREAD_ID,
      endUserId: asIdentifier<EndUserId>("end-user-2"),
    });
    expect(seen.ok).toBe(false);
    if (seen.ok) return;
    expect(seen.error.code).toBe("CONVERSATIONS_THREAD_FORBIDDEN");
  });

  it("refuses an operator read without a minted grant", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    const refused = await inspectConversation(context.dependencies, {
      authorization: { pretend: "grant" },
      scope: SCOPE,
      threadId: THREAD_ID,
      endUserId: null,
    });
    expect(refused.ok).toBe(false);
  });
});

describe("admitPage — the ceiling the source does not have", () => {
  it("admits a request inside the ceiling", () => {
    const admitted = admitPage(50, 0, CEILING);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value).toEqual({ limit: 50, offset: 0 });
  });

  it("REFUSES a limit over the ceiling rather than clamping it silently", () => {
    const refused = admitPage(CEILING + 1, 0, CEILING);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // The source's `listThreads` takes `options.limit ?? 20` with no upper bound
    // at all; `getMessages` clamps three files away. A caller that asked for
    // 10,000 and received 500 has no way to know the answer is partial.
    expect(refused.error.code).toBe("CONVERSATIONS_PAGE_REQUEST_INVALID");
    expect(refused.error.fields[0]?.code).toBe("TOO_LARGE");
  });

  it("admits exactly the ceiling", () => {
    expect(admitPage(CEILING, 0, CEILING).ok).toBe(true);
  });

  it("names the OFFSET when the offset is what is wrong", () => {
    const refused = admitPage(10, -1, CEILING);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.fields[0]?.field).toBe("offset");
    expect(refused.error.fields[0]?.code).toBe("NEGATIVE");
  });

  it("names the LIMIT when the limit is not positive", () => {
    for (const limit of [0, -5, 1.5]) {
      const refused = admitPage(limit, 0, CEILING);
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.fields[0]?.field).toBe("limit");
    }
  });
});

describe("pageConversations", () => {
  it("pages an environment's threads for an operator", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.store.seedThread(
      threadFixture({ threadId: asIdentifier<ThreadId>("thread-2"), endUserId: asIdentifier<EndUserId>("u2") }),
    );

    const page = await pageConversations(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      endUserId: null,
      limit: 10,
      offset: 0,
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.total).toBe(2);
  });

  it("excludes ARCHIVED threads unless the caller asks for them", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture({ archivedAt: new Date() }));
    const without = await pageConversations(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      endUserId: null,
      limit: 10,
      offset: 0,
    });
    if (!without.ok) throw new Error(without.error.code);
    expect(without.value.total).toBe(0);

    const with_ = await pageConversations(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      endUserId: null,
      limit: 10,
      offset: 0,
      includeArchived: true,
    });
    if (!with_.ok) throw new Error(with_.error.code);
    expect(with_.value.total).toBe(1);
  });
});

describe("pageConversationTurns", () => {
  it("resolves the THREAD first, so a foreign thread's turns cannot be paged", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.store.seedTurn(turnFixture());

    const refused = await pageConversationTurns(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      threadId: THREAD_ID,
      endUserId: asIdentifier<EndUserId>("end-user-2"),
      limit: 10,
      offset: 0,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // The repository method takes a scope and would happily answer. The
    // ordering IS the guard.
    expect(refused.error.code).toBe("CONVERSATIONS_THREAD_FORBIDDEN");
  });

  it("pages a thread's turns, excluding replies by default", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.store.seedTurn(turnFixture());
    context.store.seedTurn(
      turnFixture({
        turnId: asIdentifier<TurnId>("turn-2"),
        sequence: 2,
        parentTurnId: asIdentifier<TurnId>("turn-1"),
      }),
    );

    const page = await pageConversationTurns(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      threadId: THREAD_ID,
      endUserId: null,
      limit: 10,
      offset: 0,
    });
    if (!page.ok) throw new Error(page.error.code);
    expect(page.value.total).toBe(1);
  });

  it("applies the page ceiling on this surface too", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    const refused = await pageConversationTurns(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      threadId: THREAD_ID,
      endUserId: null,
      limit: CEILING + 1,
      offset: 0,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_PAGE_REQUEST_INVALID");
  });
});

describe("describeConversationTurn", () => {
  it("answers the turn and every step it produced — the trace a bill is read off", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.store.seedTurn(turnFixture(), [
      stepFixture(),
      stepFixture({ stepId: "step-2", sequence: 2 }),
    ]);

    const trace = await describeConversationTurn(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      turnId: asIdentifier<TurnId>("turn-1"),
    });
    expect(trace.ok).toBe(true);
    if (!trace.ok) return;
    expect(trace.value.steps).toHaveLength(2);
    expect(trace.value.steps[0]?.cost?.microCents).toBe(600_000n);
  });

  it("answers not_found for a turn that is not in this environment", async () => {
    const context = buildConversationsTestContext();
    const refused = await describeConversationTurn(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      turnId: asIdentifier<TurnId>("turn-elsewhere"),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_TURN_NOT_FOUND");
  });
});
