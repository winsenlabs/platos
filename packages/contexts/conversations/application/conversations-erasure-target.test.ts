// The erasure target, exercised THROUGH THE PUBLISHED BINDER.
//
// Every case here reaches the target with
// `createConversationsContract(...).erasureTarget()` rather than by calling the
// factory. A binder that stopped publishing the method — the exact defect
// another context shipped this month, where a context owning subject data went
// out with no reachable target and made a multi-context erasure silently
// incomplete — turns this whole file red rather than leaving it green against a
// factory nobody wires.
//
// `Turn.inputText` IS WHAT A SUBJECT SAID. That is why this suite matters more
// here than anywhere: an unpublished target would be a right-to-erasure
// operation that reports success and leaves the subject's own words behind.
//
// Mutations M-R1 (drop `erasureTarget` from the binder), M-R2 (make it fresh per
// call), M-R3 (drop the cascade from `deleteThreadsForEndUser`), M-R4 (delete
// the plan-provenance check in `erase`).

import { describe, expect, it } from "vitest";
import { asIdentifier, environmentScope, type ErasureSubject, type TransactionScope } from "@platos/kernel";

import { createConversationsContract } from "./conversations-contract.js";
import { CONVERSATIONS_ERASURE_TARGET_NAME } from "./conversations-erasure-target.js";
import {
  buildConversationsTestContext,
  END_USER_ID,
  stepFixture,
  threadFixture,
  turnFixture,
  type ConversationsTestContext,
} from "./testing/index.js";
import type { ActorId, EndUserId, PostmanContextHandle, PostmanExecutionId, ThreadId } from "../domain/index.js";
import { openPostmanExecution } from "../domain/index.js";

const TRANSACTION: TransactionScope = { transactionId: asIdentifier("txn-erasure") };
const AT = new Date("2026-01-01T00:00:00.000Z");

/** The ONE way this suite obtains a target: through the published contract. */
function targetOf(context: ConversationsTestContext) {
  return createConversationsContract(context.dependencies).erasureTarget();
}

function endUserSubject(subjectId: string = END_USER_ID): ErasureSubject {
  return {
    subjectKind: "end-user",
    subjectId,
    scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
  };
}

function operatorSubject(subjectId = "operator-1"): ErasureSubject {
  return {
    subjectKind: "user",
    subjectId,
    scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
  };
}

function seedConversation(context: ConversationsTestContext): void {
  context.store.seedThread(threadFixture());
  context.store.seedTurn(turnFixture(), [stepFixture(), stepFixture({ stepId: "step-2", sequence: 2 })]);
}

function seedExecution(context: ConversationsTestContext, simulated: EndUserId | null): void {
  context.store.seedExecution(
    openPostmanExecution({
      executionId: asIdentifier<PostmanExecutionId>("exec-1"),
      agentId: asIdentifier("agent-1"),
      requestId: "request-1",
      requestFingerprint: "sha:aaa",
      actorUserId: asIdentifier<ActorId>("operator-1"),
      simulatedEndUserId: simulated,
      contextHandle: asIdentifier<PostmanContextHandle>("handle-1"),
      contextExpiresAt: new Date("2026-01-01T01:00:00.000Z"),
      at: AT,
    }),
  );
}

describe("the target is reachable through the published contract", () => {
  it("is published, and names this context", () => {
    const contract = createConversationsContract(buildConversationsTestContext().dependencies);
    expect(typeof contract.erasureTarget).toBe("function");
    expect(contract.erasureTarget().targetName).toBe(CONVERSATIONS_ERASURE_TARGET_NAME);
    expect(contract.erasureTarget().targetName).toBe("conversations");
  });

  it("hands back the SAME target every call, so two injections cannot double-count", () => {
    const contract = createConversationsContract(buildConversationsTestContext().dependencies);
    expect(contract.erasureTarget()).toBe(contract.erasureTarget());
  });
});

describe("planning for an END USER", () => {
  it("names all four owned models, with real counts", async () => {
    const context = buildConversationsTestContext();
    seedConversation(context);
    seedExecution(context, END_USER_ID);

    const plan = await targetOf(context).plan(endUserSubject());
    expect(plan.targetName).toBe("conversations");
    expect(plan.items.map((item) => item.model)).toEqual([
      "Thread",
      "Turn",
      "Step",
      "PostmanExecution",
    ]);
    expect(plan.items.map((item) => item.rowCount)).toEqual([1, 1, 2, 1]);
  });

  it("chooses DELETE for the three conversation rows and ANONYMIZE for the audit row", async () => {
    const context = buildConversationsTestContext();
    seedConversation(context);
    const plan = await targetOf(context).plan(endUserSubject());
    expect(plan.items.map((item) => item.method)).toEqual([
      "delete",
      "delete",
      "delete",
      "anonymize",
    ]);
  });

  it("does NOT mutate: the plan leaves every row where it was", async () => {
    const context = buildConversationsTestContext();
    seedConversation(context);
    await targetOf(context).plan(endUserSubject());
    expect(context.store.threads.size).toBe(1);
    expect(context.store.turns.size).toBe(1);
    expect(context.store.steps.get("turn-1")).toHaveLength(2);
  });

  it("names a legal hold on the three conversation items when one exists", async () => {
    const context = buildConversationsTestContext();
    seedConversation(context);
    context.store.hold(asIdentifier("thread-1"));

    const plan = await targetOf(context).plan(endUserSubject());
    expect(plan.items[0]?.blockedBy).toBe("legal-hold:1");
    expect(plan.items[1]?.blockedBy).toBe("legal-hold:1");
    expect(plan.items[2]?.blockedBy).toBe("legal-hold:1");
    // The audit row is not the subject's to hold.
    expect(plan.items[3]?.blockedBy).toBeNull();
  });

  it("plans zero for a subject with nothing, rather than omitting the models", async () => {
    const context = buildConversationsTestContext();
    const plan = await targetOf(context).plan(endUserSubject("nobody"));
    expect(plan.items.map((item) => item.rowCount)).toEqual([0, 0, 0, 0]);
    expect(plan.items).toHaveLength(4);
  });
});

describe("planning for an OPERATOR — a different plan, and the only context where it is", () => {
  it("counts NO thread, no turn and no step, because an operator authors none", async () => {
    const context = buildConversationsTestContext();
    seedConversation(context);
    seedExecution(context, END_USER_ID);

    const plan = await targetOf(context).plan(operatorSubject());
    expect(plan.items.map((item) => item.rowCount)).toEqual([0, 0, 0, 1]);
  });

  it("writes the three zeros rather than leaving the models out", async () => {
    const context = buildConversationsTestContext();
    const plan = await targetOf(context).plan(operatorSubject());
    // A reader comparing two plans can then see the difference is the SUBJECT
    // and not a target that forgot a model.
    expect(plan.items.map((item) => item.model)).toEqual([
      "Thread",
      "Turn",
      "Step",
      "PostmanExecution",
    ]);
  });
});

describe("erasing", () => {
  it("deletes the threads AND CASCADES to the turns and their steps", async () => {
    const context = buildConversationsTestContext();
    seedConversation(context);
    const target = targetOf(context);
    const plan = await target.plan(endUserSubject());

    const receipt = await target.erase(plan, TRANSACTION);
    expect(receipt.targetName).toBe("conversations");
    expect(context.store.threads.size).toBe(0);
    // `Turn.thread` and `Step.turn` are both `onDelete: Cascade`. A partial
    // cascade is how a step outlives the turn it belongs to.
    expect(context.store.turns.size).toBe(0);
    expect(context.store.steps.size).toBe(0);
  });

  it("ANONYMIZES the audit row rather than deleting it, keeping the operator's trail", async () => {
    const context = buildConversationsTestContext();
    seedExecution(context, END_USER_ID);
    const target = targetOf(context);
    const plan = await target.plan(endUserSubject());
    await target.erase(plan, TRANSACTION);

    const survived = context.store.executions.get("exec-1");
    expect(survived).toBeDefined();
    expect(survived?.simulatedEndUserId).toBeNull();
    // `actorUserId` is `onDelete: Restrict` to `User`: deleting the row would
    // erase the record that an operator ran an agent.
    expect(survived?.actorUserId).toBe("operator-1");
  });

  it("stamps the receipt with the clock it was given, not the wall clock", async () => {
    const context = buildConversationsTestContext();
    const target = targetOf(context);
    const receipt = await target.erase(await target.plan(endUserSubject()), TRANSACTION);
    expect(receipt.erasedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("REFUSES a plan this target did not produce", async () => {
    const context = buildConversationsTestContext();
    const target = targetOf(context);
    const foreign = { targetName: "memory", items: [] };
    await expect(target.erase(foreign, TRANSACTION)).rejects.toThrow(
      /this plan was not produced by this target/u,
    );
  });

  it("REFUSES a plan of OURS whose target name was tampered with after it was built", async () => {
    // The WeakMap knows this object — it IS the plan `plan()` returned — so the
    // provenance check passes and the SECOND check, on the name the plan
    // carries, is the one that has to fire. Without a case that reaches it, that
    // check was unreachable from the published surface and deleting it left
    // every case green.
    const context = buildConversationsTestContext();
    seedConversation(context);
    const target = targetOf(context);
    const plan = (await target.plan(endUserSubject())) as { targetName: string };
    plan.targetName = "files";

    await expect(target.erase(plan as never, TRANSACTION)).rejects.toThrow(/files/u);
    // And nothing was erased on the way to refusing.
    expect(context.store.threads.has("thread-1")).toBe(true);
  });

  it("REFUSES a plan that claims to be ours but was built elsewhere", async () => {
    const context = buildConversationsTestContext();
    const target = targetOf(context);
    const forged = { targetName: "conversations", items: [] };
    await expect(target.erase(forged, TRANSACTION)).rejects.toThrow();
  });

  it("leaves ANOTHER end user's conversation entirely alone", async () => {
    const context = buildConversationsTestContext();
    seedConversation(context);
    context.store.seedThread(
      threadFixture({
        threadId: asIdentifier<ThreadId>("thread-2"),
        endUserId: asIdentifier<EndUserId>("end-user-2"),
      }),
    );

    const target = targetOf(context);
    await target.erase(await target.plan(endUserSubject()), TRANSACTION);
    expect(context.store.threads.has("thread-2")).toBe(true);
    expect(context.store.threads.has("thread-1")).toBe(false);
  });
});
