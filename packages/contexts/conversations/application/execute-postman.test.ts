// The operator-launched run: two grants, a replay, a collision and an expiry.
//
// Mutations M-PM1 (the operator grant), M-PM2 (the runtime grant), M-PM3 (the
// fingerprint comparison), M-PM4 (the handle expiry), M-PM5 (the settle-once
// rule reaching the use case).

import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentScope } from "@platos/kernel";

import { describeExecution, launchPostmanExecution, settleExecution } from "./execute-postman.js";
import { AGENT_ID, buildConversationsTestContext, END_USER_ID, runtimeGrant, THREAD_ID } from "./testing/index.js";
import type {
  ActorId,
  PostmanContextHandle,
  PostmanExecutionId,
  PostmanTemplateId,
  TurnId,
} from "../domain/index.js";

const SCOPE = {
  level: "environment",
  organizationId: "org-1",
  projectId: "proj-1",
  environmentId: "env-1",
} as EnvironmentScope;

const HANDLE = asIdentifier<PostmanContextHandle>("handle-1");
const TEMPLATE = asIdentifier<PostmanTemplateId>("template-1");

function launch(context: ReturnType<typeof buildConversationsTestContext>, overrides: Record<string, unknown> = {}) {
  return launchPostmanExecution(context.dependencies, {
    authorization: context.tenancy.grant(),
    runtimeAuthorization: runtimeGrant(),
    scope: SCOPE,
    agentId: AGENT_ID,
    templateId: TEMPLATE,
    requestId: "request-1",
    requestFingerprint: "sha:aaa",
    actorUserId: asIdentifier<ActorId>("operator-1"),
    simulatedEndUserId: END_USER_ID,
    contextHandle: HANDLE,
    handleLifetimeMs: 900_000,
    ...overrides,
  } as Parameters<typeof launchPostmanExecution>[1]);
}

describe("launchPostmanExecution", () => {
  it("records the operator, the simulated end user and a live handle", async () => {
    const context = buildConversationsTestContext();
    const launched = await launch(context);
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(launched.value.replayed).toBe(false);
    expect(launched.value.execution.actorUserId).toBe("operator-1");
    expect(launched.value.execution.simulatedEndUserId).toBe(END_USER_ID);
    expect(launched.value.execution.contextExpiresAt).toEqual(
      new Date("2026-01-01T00:15:00.000Z"),
    );
  });

  it("demands BOTH grants: an operator one alone is not enough", async () => {
    const context = buildConversationsTestContext();
    const refused = await launch(context, {
      runtimeAuthorization: runtimeGrant({ ...SCOPE, environmentId: "env-2" } as EnvironmentScope),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_SCOPE_MISMATCH");
    expect(context.store.executions.size).toBe(0);
  });

  it("demands BOTH grants: a runtime one alone is not enough either", async () => {
    const context = buildConversationsTestContext();
    const refused = await launch(context, { authorization: { looks: "operatorish" } });
    expect(refused.ok).toBe(false);
    expect(context.store.executions.size).toBe(0);
  });

  it("answers the EXISTING execution on a retry with the same fingerprint", async () => {
    const context = buildConversationsTestContext();
    const first = await launch(context);
    if (!first.ok) throw new Error(first.error.code);
    const second = await launch(context);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.execution.executionId).toBe(first.value.execution.executionId);
    expect(context.store.executions.size).toBe(1);
  });

  it("REFUSES the same request id with a DIFFERENT body", async () => {
    const context = buildConversationsTestContext();
    await launch(context);
    const refused = await launch(context, { requestFingerprint: "sha:bbb" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // Answering the first execution would hand this caller a result computed
    // from another request, which the unique constraint cannot prevent.
    expect(refused.error.code).toBe("CONVERSATIONS_POSTMAN_FINGERPRINT_MISMATCH");
  });

  it("always creates for an AD-HOC request, because the constraint is vacuous", async () => {
    const context = buildConversationsTestContext();
    await launch(context, { templateId: null, contextHandle: asIdentifier<PostmanContextHandle>("h-1") });
    await launch(context, { templateId: null, contextHandle: asIdentifier<PostmanContextHandle>("h-2") });
    expect(context.store.executions.size).toBe(2);
  });
});

describe("settleExecution", () => {
  it("binds the thread and the turn, closes the execution and emits", async () => {
    const context = buildConversationsTestContext();
    await launch(context);

    const settled = await settleExecution(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      contextHandle: HANDLE,
      threadId: THREAD_ID,
      turnId: asIdentifier<TurnId>("turn-1"),
      succeeded: true,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.status).toBe("SUCCEEDED");
    expect(settled.value.threadId).toBe(THREAD_ID);
    expect(settled.value.turnId).toBe("turn-1");
    expect(context.outbox.names()).toEqual(["conversations.postman.executed"]);
  });

  it("REFUSES an expired handle, which the source never checks", async () => {
    const context = buildConversationsTestContext();
    await launch(context);
    context.clock.advance(900_001);

    const refused = await settleExecution(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      contextHandle: HANDLE,
      threadId: THREAD_ID,
      turnId: asIdentifier<TurnId>("turn-1"),
      succeeded: true,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_POSTMAN_HANDLE_EXPIRED");
    expect(context.outbox.appended).toHaveLength(0);
  });

  it("answers not_found for a handle that names nothing, before any expiry check", async () => {
    const context = buildConversationsTestContext();
    const refused = await settleExecution(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      contextHandle: asIdentifier<PostmanContextHandle>("unknown"),
      threadId: THREAD_ID,
      turnId: asIdentifier<TurnId>("turn-1"),
      succeeded: true,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // Ordering matters: an expired handle must not reveal that SOME execution
    // exists behind an id the caller guessed.
    expect(refused.error.code).toBe("CONVERSATIONS_POSTMAN_NOT_FOUND");
  });

  it("refuses a SECOND settlement", async () => {
    const context = buildConversationsTestContext();
    await launch(context);
    const grant = context.tenancy.grant();
    const command = {
      authorization: grant,
      scope: SCOPE,
      contextHandle: HANDLE,
      threadId: THREAD_ID,
      turnId: asIdentifier<TurnId>("turn-1"),
      succeeded: true,
    };
    const first = await settleExecution(context.dependencies, command);
    expect(first.ok).toBe(true);
    const second = await settleExecution(context.dependencies, command);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("CONVERSATIONS_POSTMAN_ALREADY_SETTLED");
  });
});

describe("describeExecution", () => {
  it("answers an execution to an operator with a grant", async () => {
    const context = buildConversationsTestContext();
    const launched = await launch(context);
    if (!launched.ok) throw new Error(launched.error.code);
    const found = await describeExecution(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      executionId: launched.value.execution.executionId,
    });
    expect(found.ok).toBe(true);
  });

  it("answers not_found for an execution in another environment", async () => {
    const context = buildConversationsTestContext();
    const refused = await describeExecution(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      executionId: asIdentifier<PostmanExecutionId>("exec-elsewhere"),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_POSTMAN_NOT_FOUND");
  });
});
