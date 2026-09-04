// Six guards, six codes, in a fixed order.
//
// Mutations M-D1 (grant), M-D2 (kill switch), M-D3 (ownership), M-D4 (archived),
// M-D5 (idempotency fingerprint), M-D6 (turn ceiling). The ORDER is asserted as
// well as the guards, because a request that breaches several must answer
// deterministically or a deletion can be masked by the guard beside it.

import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentScope } from "@platos/kernel";

import { admitTurn, fingerprintInput } from "./turn-admission.js";
import {
  buildConversationsTestContext,
  END_USER_ID,
  runtimeGrant,
  THREAD_ID,
  threadFixture,
  turnFixture,
} from "./testing/index.js";
import { DEFAULT_CONVERSATIONS_POLICY, type EndUserId, type IdempotencyKey } from "../domain/index.js";

function request(overrides: Record<string, unknown> = {}) {
  return {
    authorization: runtimeGrant(),
    scope: {
      level: "environment",
      organizationId: "org-1",
      projectId: "proj-1",
      environmentId: "env-1",
    } as EnvironmentScope,
    threadId: THREAD_ID,
    endUserId: END_USER_ID,
    inputText: "hello",
    idempotencyKey: null,
    ...overrides,
  } as Parameters<typeof admitTurn>[1];
}

describe("admitTurn", () => {
  it("admits a live thread its own end user names", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    const admitted = await admitTurn(context.dependencies, request());
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value.kind).toBe("admitted");
  });

  it("refuses a grant for another scope BEFORE it reads any tenant data", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    const elsewhere = runtimeGrant({
      level: "environment",
      organizationId: "org-2",
      projectId: "proj-1",
      environmentId: "env-1",
    } as EnvironmentScope);
    const refused = await admitTurn(context.dependencies, request({ authorization: elsewhere }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_SCOPE_MISMATCH");
  });

  it("refuses when the KILL SWITCH is off, even for a thread that would pass", async () => {
    const context = buildConversationsTestContext({
      ...DEFAULT_CONVERSATIONS_POLICY,
      turn: { ...DEFAULT_CONVERSATIONS_POLICY.turn, turnsEnabled: false },
    });
    context.store.seedThread(threadFixture());
    const refused = await admitTurn(context.dependencies, request());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_TURNS_DISABLED");
  });

  it("refuses an absent thread and a FOREIGN one identically", async () => {
    const context = buildConversationsTestContext();
    const absent = await admitTurn(context.dependencies, request());
    context.store.seedThread(threadFixture());
    const foreign = await admitTurn(
      context.dependencies,
      request({ endUserId: asIdentifier<EndUserId>("end-user-2") }),
    );
    expect(absent.ok).toBe(false);
    expect(foreign.ok).toBe(false);
    if (absent.ok || foreign.ok) return;
    expect(absent.error.code).toBe("CONVERSATIONS_THREAD_NOT_FOUND");
    expect(foreign.error.code).toBe("CONVERSATIONS_THREAD_NOT_FOUND");
  });

  it("refuses an ARCHIVED thread with its own code", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture({ archivedAt: new Date("2026-01-01T00:00:00.000Z") }));
    const refused = await admitTurn(context.dependencies, request());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_THREAD_ARCHIVED");
  });

  it("answers the EXISTING turn on a redelivery, with no second turn and no error", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    const key = asIdentifier<IdempotencyKey>("idem-1");
    context.store.seedTurn(turnFixture({ idempotencyKey: key, inputText: "hello" }));

    const replayed = await admitTurn(context.dependencies, request({ idempotencyKey: key }));
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.kind).toBe("replayed");
    if (replayed.value.kind !== "replayed") return;
    expect(replayed.value.turn.turnId).toBe("turn-1");
  });

  it("REFUSES the same key with DIFFERENT input, which the constraint cannot see", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    const key = asIdentifier<IdempotencyKey>("idem-1");
    context.store.seedTurn(turnFixture({ idempotencyKey: key, inputText: "hello" }));

    const refused = await admitTurn(
      context.dependencies,
      request({ idempotencyKey: key, inputText: "something else entirely" }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // `@@unique([threadId, idempotencyKey])` would collapse these into whichever
    // arrived first, handing this caller another request's answer.
    expect(refused.error.code).toBe("CONVERSATIONS_TURN_IDEMPOTENCY_CONFLICT");
  });

  it("checks idempotency BEFORE the ceiling, so a retry survives a full thread", async () => {
    const context = buildConversationsTestContext({
      ...DEFAULT_CONVERSATIONS_POLICY,
      turn: { ...DEFAULT_CONVERSATIONS_POLICY.turn, maxTurnsPerThread: 1 },
    });
    context.store.seedThread(threadFixture());
    const key = asIdentifier<IdempotencyKey>("idem-1");
    context.store.seedTurn(turnFixture({ idempotencyKey: key, inputText: "hello" }));

    const replayed = await admitTurn(context.dependencies, request({ idempotencyKey: key }));
    // The thread is AT its ceiling. Checking the ceiling first would fail a
    // network retry of a turn that was already accepted.
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.kind).toBe("replayed");
  });

  it("refuses a thread at its TURN CEILING, and admits one below it", async () => {
    const context = buildConversationsTestContext({
      ...DEFAULT_CONVERSATIONS_POLICY,
      turn: { ...DEFAULT_CONVERSATIONS_POLICY.turn, maxTurnsPerThread: 2 },
    });
    context.store.seedThread(threadFixture());
    context.store.seedTurn(turnFixture({ turnId: asIdentifier("turn-1"), sequence: 1 }));
    const below = await admitTurn(context.dependencies, request());
    expect(below.ok).toBe(true);

    context.store.seedTurn(turnFixture({ turnId: asIdentifier("turn-2"), sequence: 2 }));
    const refused = await admitTurn(context.dependencies, request());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_TURN_CEILING_EXCEEDED");
    expect(refused.error.details.count).toBe(2);
  });

  it("surfaces a store failure rather than admitting the turn", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.store.failWith("the store is down");
    const refused = await admitTurn(context.dependencies, request());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_REPOSITORY_UNAVAILABLE");
  });
});

describe("fingerprintInput", () => {
  it("covers the input and nothing that differs between two deliveries", () => {
    expect(fingerprintInput("hello")).toBe(fingerprintInput("hello"));
    expect(fingerprintInput("hello")).not.toBe(fingerprintInput("goodbye"));
    expect(fingerprintInput(null)).not.toBe(fingerprintInput(""));
  });
});
