// The orchestrator: what it spends, what it emits, and what it does not do.
//
// Mutations M-Q1 (the budget guard), M-Q2 (the transaction around the
// settlement and its event), M-Q3 (the settle-on-failure path), M-Q4 (the abort
// path keeping its steps), M-Q5 (the step clamp reaching `providers`).

import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentScope } from "@platos/kernel";

import { runTurn } from "./run-turn.js";
import {
  buildConversationsTestContext,
  END_USER_ID,
  runtimeGrant,
  THREAD_ID,
  threadFixture,
} from "./testing/index.js";
import { DEFAULT_CONVERSATIONS_POLICY, type IdempotencyKey } from "../domain/index.js";

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
    inputText: "what is the answer",
    canaryDraw: 0.9,
    ...overrides,
  } as Parameters<typeof runTurn>[1];
}

describe("runTurn", () => {
  it("runs a turn, settles it, and derives its cost from the steps", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());

    const ran = await runTurn(context.dependencies, command());
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(ran.value.turn.status).toBe("SUCCEEDED");
    expect(ran.value.turn.outputText).toBe("the answer");
    expect(ran.value.steps).toHaveLength(1);
    // 1,000 input at 3e-6 + 200 output at 1.5e-5 = 0.003 + 0.003 USD = 0.6 cents.
    expect(ran.value.turn.cost.amount.microCents).toBe(600_000n);
    expect(ran.value.turn.usage.inputTokens).toBe(1_000);
    expect(ran.value.turn.usage.outputTokens).toBe(200);
  });

  it("emits `conversations.turn.settled` with the EXACT cost as a cent string", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());

    await runTurn(context.dependencies, command());
    expect(context.outbox.names()).toEqual(["conversations.turn.settled"]);
    const payload = context.outbox.appended[0]?.payload as Record<string, unknown>;
    expect(payload.costCents).toBe("0.600000");
    expect(payload.costComplete).toBe(true);
    expect(payload.inputTokens).toBe(1_000);
    expect(payload.outputTokens).toBe(200);
    expect(payload.stepCount).toBe(1);
    // Never a JSON number: six decimal places do not survive a float.
    expect(typeof payload.costCents).toBe("string");
  });

  it("writes the settlement and the event in ONE transaction", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());

    await runTurn(context.dependencies, command());
    expect(context.unitOfWork.transactions).toBe(1);
    expect(context.outbox.appended[0]?.transactionId).toBe("txn-1");
  });

  it("does NOT write a spend ledger: the event carries the cost and nothing calls back", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());

    await runTurn(context.dependencies, command());
    // `guardSpend` is the ONLY cost-monitoring call. `recordTurn` is not on the
    // narrow port at all, which is what makes this context a DAG sink.
    expect(context.costMonitoring.guarded).toHaveLength(1);
    expect("recordTurn" in context.costMonitoring).toBe(false);
  });

  it("guards the budget BEFORE the provider is called at all", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.costMonitoring.blocked = true;

    const refused = await runTurn(context.dependencies, command());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_BUDGET_EXHAUSTED");
    expect(context.providers.generated).toHaveLength(0);
    expect(context.store.turns.size).toBe(0);
  });

  it("clamps the agent's step budget before it reaches `providers`", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());

    await runTurn(context.dependencies, command({ requestedMaxSteps: 100_000 }));
    expect(context.providers.generated[0]?.maxSteps).toBe(
      DEFAULT_CONVERSATIONS_POLICY.turn.maxStepsPerTurn,
    );
  });

  it("pins the version and its bucket onto the turn, from the draw it was given", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.agents.bucket = "CANARY";

    const drawn = await runTurn(context.dependencies, command({ canaryDraw: 0.1 }));
    if (!drawn.ok) throw new Error(drawn.error.code);
    expect(drawn.value.turn.versionBucket).toBe("CANARY");

    const notDrawn = await runTurn(context.dependencies, command({ canaryDraw: 0.7 }));
    if (!notDrawn.ok) throw new Error(notDrawn.error.code);
    expect(notDrawn.value.turn.versionBucket).toBe("CURRENT");
  });

  it("SETTLES the turn as FAILED when the provider refuses, and still emits", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.providers.failWith("the provider is down");

    const refused = await runTurn(context.dependencies, command());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_GENERATION_FAILED");

    const stored = [...context.store.turns.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("FAILED");
    // A row with its input intact rather than nothing at all.
    expect(stored[0]?.inputText).toBe("what is the answer");
    expect(context.outbox.names()).toEqual(["conversations.turn.failed"]);
  });

  it("CANCELS an aborted turn and KEEPS the money its steps already spent", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.providers.finishReason = "aborted";
    context.providers.steps = [context.providers.step({ inputTokens: 4_000, outputTokens: 0 })];

    const ran = await runTurn(context.dependencies, command());
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(ran.value.turn.status).toBe("CANCELLED");
    // 4,000 x 3e-6 USD = 1.2 cents. The source loses this entirely.
    expect(ran.value.turn.cost.amount.microCents).toBe(1_200_000n);
    expect(context.outbox.names()).toEqual(["conversations.turn.abandoned"]);
  });

  it("answers a REDELIVERY with the original turn and spends nothing", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    const key = asIdentifier<IdempotencyKey>("idem-1");

    const first = await runTurn(context.dependencies, command({ idempotencyKey: key }));
    if (!first.ok) throw new Error(first.error.code);
    const generatedOnce = context.providers.generated.length;

    const second = await runTurn(context.dependencies, command({ idempotencyKey: key }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.turn.turnId).toBe(first.value.turn.turnId);
    expect(context.providers.generated).toHaveLength(generatedOnce);
    expect(context.store.turns.size).toBe(1);
  });

  it("allocates a dense sequence, one per turn, never repeating", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());

    await runTurn(context.dependencies, command());
    await runTurn(context.dependencies, command());
    await runTurn(context.dependencies, command());
    expect(context.store.allocated).toEqual([1, 2, 3]);
    expect(new Set(context.store.allocated).size).toBe(3);
  });

  it("hands `providers` the catalogue it composed, and no tool it did not", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.skills.tools = [
      { name: "lookup", description: "look it up", inputSchema: { type: "object" } },
    ];

    await runTurn(context.dependencies, command());
    expect(context.providers.generated[0]?.toolNames).toEqual(["lookup"]);
  });

  it("runs WITHOUT memory when retrieval refuses, and says so in the log", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.memory.failWith("the vector store timed out");

    const ran = await runTurn(context.dependencies, command());
    expect(ran.ok).toBe(true);
    const warned = context.logger.lines.find(
      (line) => line.message === "conversations.memory.skipped",
    );
    // "Skipped" and "empty" are distinguishable here, which a bare `catch {}`
    // does not make them.
    expect(warned?.level).toBe("warn");
    expect(warned?.fields.code).toBe("CONVERSATIONS_REPOSITORY_UNAVAILABLE");
  });

  it("FAILS the turn when the ROUTE cannot be resolved, unlike memory", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());
    context.agents.failWith("no route");

    const refused = await runTurn(context.dependencies, command());
    expect(refused.ok).toBe(false);
    expect(context.providers.generated).toHaveLength(0);
  });

  it("refuses when the KILL SWITCH is off, before it reads the thread", async () => {
    const context = buildConversationsTestContext({
      ...DEFAULT_CONVERSATIONS_POLICY,
      turn: { ...DEFAULT_CONVERSATIONS_POLICY.turn, turnsEnabled: false },
    });
    context.store.seedThread(threadFixture());
    const refused = await runTurn(context.dependencies, command());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_TURNS_DISABLED");
    expect(context.providers.generated).toHaveLength(0);
  });

  it("rolls back the settlement AND its event when the store refuses inside the transaction", async () => {
    const context = buildConversationsTestContext();
    context.store.seedThread(threadFixture());

    // Fail only once the turn is open, so the write inside the transaction is
    // the one that refuses.
    const original = context.store.saveSettlement;
    context.store.saveSettlement = (async () => {
      context.store.failWith("the store went away");
      return original.call(context.store, SCOPE, { turn: {} as never, steps: [] });
    }) as typeof original;

    const refused = await runTurn(context.dependencies, command());
    expect(refused.ok).toBe(false);
    expect(context.unitOfWork.rollbacks).toBe(1);

    // FAILURE INJECTION, AND THE POINT IS THAT NEITHER WRITE SURVIVED. Counting
    // the rollback alone would pass against a unit of work that incremented a
    // number and left both writes in place. `conversations.turn.settled` is what
    // `cost-monitoring` bills off, so an event that outlived its own settlement
    // would charge for a turn no row records.
    expect(context.outbox.names()).toEqual([]);
    // The turn row is created BEFORE the transaction and stays: it is the open
    // row the settlement was going to close. What must not survive is the
    // settlement, and it did not — the stored status is still the one
    // `createTurn` wrote, and no step row landed beside it.
    const [surviving] = [...context.store.turns.values()];
    expect(surviving?.status).toBe("PENDING");
    expect(surviving?.completedAt).toBeNull();
    expect([...context.store.steps.values()].flat()).toEqual([]);
  });
});
