import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";
import {
  postmanContextRedisKey,
  resolvePostmanContext,
  traceSessionContext,
} from "./postman-context-handle";
import { buildSessionScope } from "./session-scope";

const ids = {
  organization: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  environment: "33333333-3333-4333-8333-333333333333",
  operator: "44444444-4444-4444-8444-444444444444",
  agent: "55555555-5555-4555-8555-555555555555",
  template: "66666666-6666-4666-8666-666666666666",
  endUser: "77777777-7777-4777-8777-777777777777",
  request: "88888888-8888-4888-8888-888888888888",
  execution: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  thread: "99999999-9999-4999-8999-999999999999",
  turn: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} as const;

const scope = {
  organizationId: ids.organization,
  projectId: ids.project,
  environmentId: ids.environment,
  userId: ids.operator,
  principal: "operator" as const,
};

const idempotencyKey = `postman:${ids.template}:${ids.request}`;

function persistedTurn() {
  return {
    id: ids.turn,
    threadId: ids.thread,
    sequence: 1,
    status: "SUCCEEDED",
    idempotencyKey,
    inputText: "hello",
    outputText: "persisted answer",
    createdAt: new Date("2026-08-24T12:00:00.000Z"),
    completedAt: new Date("2026-08-24T12:00:01.000Z"),
  };
}

function harness(role: "OWNER" | "ADMIN" | "MEMBER" | null = "OWNER") {
  const redisValues = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: string) => {
      if (redisValues.has(key)) return null;
      redisValues.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => redisValues.get(key) ?? null),
    del: vi.fn(async (key: string) => redisValues.delete(key) ? 1 : 0),
  };
  let execution: any = null;
  let turns: any[] = [];
  const prisma: any = {
    organizationMembership: {
      findFirst: vi.fn().mockResolvedValue(role ? { role } : null),
    },
    postmanTemplate: {
      findFirst: vi.fn().mockResolvedValue({
        id: ids.template,
        agentId: ids.agent,
        simulateUserId: ids.endUser,
        sessionContext: { account: "persisted", locale: "en" },
      }),
    },
    endUser: {
      findFirst: vi.fn().mockResolvedValue({
        id: ids.endUser,
        identities: [{ subject: "customer-external-42" }],
      }),
    },
    postmanExecution: {
      findFirst: vi.fn(async () => execution),
      create: vi.fn(async ({ data }: any) => {
        execution = { id: ids.execution, ...data, threadId: null, turnId: null };
        return execution;
      }),
      update: vi.fn(async ({ data }: any) => {
        execution = { ...execution, ...data };
        return execution;
      }),
    },
    thread: {
      findFirst: vi.fn().mockResolvedValue({ id: ids.thread }),
    },
    turn: {
      findMany: vi.fn(async ({ where }: any) => {
        if (where.idempotencyKey) {
          return turns
            .filter((turn) => turn.idempotencyKey === where.idempotencyKey)
            .map((turn) => ({ threadId: turn.threadId }));
        }
        return turns.filter((turn) => turn.threadId === where.threadId);
      }),
    },
  };
  const dispatch = {
    collectTurn: vi.fn(async (_agentId: string, _options: any) => {
      turns = [persistedTurn()];
      return {
        text: "transport answer",
        threadId: ids.thread,
        costCents: 1,
        messageId: ids.turn,
      };
    }),
  };
  const controller: any = Object.create(AgentController.prototype);
  controller.agentService = { prisma };
  controller.dispatch = dispatch;
  controller.redis = redis;
  return {
    controller,
    dispatch,
    prisma,
    redis,
    redisValues,
    req: { scope } as any,
    body: {
      message: " hello ",
      requestId: ids.request,
      sessionContextOverride: {
        account: "one-turn",
        sentinel: "OVERRIDE_SECRET_SENTINEL",
      },
    },
    execution: () => execution,
    setExecution: (value: any) => { execution = value; },
    turns: () => turns,
    setTurns: (value: any[]) => { turns = value; },
  };
}

describe("AgentController executable Postman mode", () => {
  it.each(["OWNER", "ADMIN"] as const)(
    "reserves and executes one source-backed Turn for an Organization %s",
    async (role) => {
      const h = harness(role);

      const result = await h.controller.executePostmanTemplate(
        h.req,
        ids.template,
        h.body,
      );

      expect(h.dispatch.collectTurn).toHaveBeenCalledTimes(1);
      const dispatchOptions = h.dispatch.collectTurn.mock.calls[0]![1];
      expect(dispatchOptions).toMatchObject({
        scope: {
          organizationId: ids.organization,
          projectId: ids.project,
          environmentId: ids.environment,
          agentId: ids.agent,
          userId: "customer-external-42",
          operatorUserId: ids.operator,
          principal: "operator",
          sessionContext: undefined,
          sessionContextHandle: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
        message: "hello",
        idempotencyKey,
      });
      const triggerScope = buildSessionScope(dispatchOptions.scope);
      expect(triggerScope).toMatchObject({
        userId: "customer-external-42",
        operatorUserId: ids.operator,
        sessionContextHandle: dispatchOptions.scope.sessionContextHandle,
      });
      expect(triggerScope).not.toHaveProperty("sessionContext");
      expect(JSON.stringify(triggerScope)).not.toContain("OVERRIDE_SECRET_SENTINEL");

      const handle = dispatchOptions.scope.sessionContextHandle;
      const stored = JSON.parse(h.redisValues.get(postmanContextRedisKey(handle))!);
      expect(stored.context).toEqual({
        account: "one-turn",
        locale: "en",
        sentinel: "OVERRIDE_SECRET_SENTINEL",
      });
      expect(await resolvePostmanContext(
        h.redis as any,
        handle,
        dispatchOptions.scope,
        idempotencyKey,
      )).toEqual(stored.context);
      expect(traceSessionContext({
        ...dispatchOptions.scope,
        sessionContext: stored.context,
      })).toBeUndefined();

      expect(h.prisma.postmanExecution.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          environmentId: ids.environment,
          agentId: ids.agent,
          templateId: ids.template,
          requestId: ids.request,
          actorUserId: ids.operator,
          simulatedEndUserId: ids.endUser,
          contextHandle: handle,
          status: "ACTIVE",
        }),
      });
      expect(JSON.stringify(h.prisma.postmanExecution.create.mock.calls[0]![0]))
        .not.toContain("OVERRIDE_SECRET_SENTINEL");
      expect(h.execution()).toMatchObject({
        id: ids.execution,
        actorUserId: ids.operator,
        threadId: ids.thread,
        turnId: ids.turn,
        status: "SUCCEEDED",
      });
      expect(result.execution).toMatchObject({
        executionId: ids.execution,
        requestId: ids.request,
        templateId: ids.template,
        agentId: ids.agent,
        simulatedEndUserId: ids.endUser,
        threadId: ids.thread,
        turnId: ids.turn,
        turnCount: 1,
        status: "SUCCEEDED",
        inputText: "hello",
        outputText: "persisted answer",
        recovered: false,
      });
      expect(JSON.stringify(result)).not.toContain("OVERRIDE_SECRET_SENTINEL");
      expect(JSON.stringify(result)).not.toContain("sessionContext");
    },
  );

  it("rejects Organization MEMBER before any scoped target lookup", async () => {
    const h = harness("MEMBER");

    const error = await h.controller
      .executePostmanTemplate(h.req, ids.template, h.body)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: "POSTMAN_EXECUTION_FORBIDDEN",
    });
    expect(h.prisma.postmanTemplate.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.endUser.findFirst).not.toHaveBeenCalled();
    expect(h.dispatch.collectTurn).not.toHaveBeenCalled();
  });

  it("returns retryable 503 when the role lookup is unavailable", async () => {
    const h = harness("OWNER");
    h.prisma.organizationMembership.findFirst.mockRejectedValue(new Error("db down"));

    const error = await h.controller
      .executePostmanTemplate(h.req, ids.template, h.body)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "POSTMAN_EXECUTION_UNAVAILABLE",
    });
    expect(h.prisma.postmanTemplate.findFirst).not.toHaveBeenCalled();
  });

  it.each(["template", "EndUser"])(
    "returns the same stable not-found response for a cross-scope %s",
    async (target) => {
      const h = harness("OWNER");
      if (target === "template") h.prisma.postmanTemplate.findFirst.mockResolvedValue(null);
      else h.prisma.endUser.findFirst.mockResolvedValue(null);

      const error = await h.controller
        .executePostmanTemplate(h.req, ids.template, h.body)
        .catch((value: unknown) => value);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toEqual({
        code: "POSTMAN_EXECUTION_NOT_FOUND",
        message: "Postman execution target was not found in scope",
      });
      expect(h.dispatch.collectTurn).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], "{}", { ok: true }])(
    "rejects malformed or unsupported override input without dispatching (%j)",
    async (sessionContextOverride) => {
      const h = harness("ADMIN");
      const body = sessionContextOverride && !Array.isArray(sessionContextOverride) && typeof sessionContextOverride === "object"
        ? { ...h.body, sessionContextOverride, unsupported: true }
        : { ...h.body, sessionContextOverride };

      const error = await h.controller
        .executePostmanTemplate(h.req, ids.template, body)
        .catch((value: unknown) => value);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: "POSTMAN_EXECUTION_INVALID_REQUEST",
      });
      expect(h.dispatch.collectTurn).not.toHaveBeenCalled();
    },
  );

  it("recovers a persisted reservation and Turn without a second dispatch", async () => {
    const h = harness("OWNER");
    await h.controller.executePostmanTemplate(h.req, ids.template, h.body);
    h.dispatch.collectTurn.mockClear();

    const result = await h.controller.executePostmanTemplate(
      h.req,
      ids.template,
      h.body,
    );

    expect(h.dispatch.collectTurn).not.toHaveBeenCalled();
    expect(result.execution).toMatchObject({
      executionId: ids.execution,
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      turnCount: 1,
      recovered: true,
    });
  });

  it("keeps an incomplete durable reservation retryable without dispatching", async () => {
    const h = harness("OWNER");
    h.setExecution({
      id: ids.execution,
      environmentId: ids.environment,
      agentId: ids.agent,
      templateId: ids.template,
      requestId: ids.request,
      requestFingerprint: "09dfe4b9ba46e5eb8c5eb2b6fa15f406b959d3153bc53860e74b0314fc3086c0",
      actorUserId: ids.operator,
      simulatedEndUserId: ids.endUser,
      threadId: null,
      turnId: null,
    });
    const first = harness("OWNER");
    await first.controller.executePostmanTemplate(first.req, ids.template, first.body);
    h.setExecution({ ...first.execution(), threadId: null, turnId: null });

    const error = await h.controller
      .executePostmanTemplate(h.req, ids.template, h.body)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "POSTMAN_EXECUTION_IN_PROGRESS",
    });
    expect(h.dispatch.collectTurn).not.toHaveBeenCalled();
  });

  it("rejects reuse of a requestId with different request content", async () => {
    const h = harness("OWNER");
    await h.controller.executePostmanTemplate(h.req, ids.template, h.body);
    h.dispatch.collectTurn.mockClear();

    const error = await h.controller
      .executePostmanTemplate(h.req, ids.template, {
        ...h.body,
        message: "different",
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: "POSTMAN_EXECUTION_REQUEST_MISMATCH",
    });
    expect(h.dispatch.collectTurn).not.toHaveBeenCalled();
  });

  it("recovers after an ambiguous dispatch failure without creating a new Turn", async () => {
    const h = harness("OWNER");
    h.dispatch.collectTurn.mockImplementationOnce(async () => {
      h.setTurns([persistedTurn()]);
      throw new Error("response lost after commit");
    });

    const firstError = await h.controller
      .executePostmanTemplate(h.req, ids.template, h.body)
      .catch((value: unknown) => value);
    expect(firstError).toBeInstanceOf(ServiceUnavailableException);
    expect((firstError as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "POSTMAN_EXECUTION_UNAVAILABLE",
    });

    const result = await h.controller.executePostmanTemplate(
      h.req,
      ids.template,
      h.body,
    );

    expect(h.dispatch.collectTurn).toHaveBeenCalledTimes(1);
    expect(h.turns()).toHaveLength(1);
    expect(result.execution).toMatchObject({
      turnId: ids.turn,
      recovered: true,
    });
  });

  it("recovers the winning reservation after a concurrent create race", async () => {
    const h = harness("OWNER");
    const winner = harness("OWNER");
    await winner.controller.executePostmanTemplate(winner.req, ids.template, winner.body);
    const winningExecution = { ...winner.execution(), threadId: null, turnId: null };
    h.prisma.postmanExecution.create.mockRejectedValueOnce({ code: "P2002" });
    h.prisma.postmanExecution.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winningExecution);

    const error = await h.controller
      .executePostmanTemplate(h.req, ids.template, h.body)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "POSTMAN_EXECUTION_IN_PROGRESS",
    });
    expect(h.redis.del).toHaveBeenCalledTimes(1);
    expect(h.dispatch.collectTurn).not.toHaveBeenCalled();
  });

  it("fails closed when read-back does not prove exactly one matching Turn", async () => {
    const h = harness("OWNER");
    h.dispatch.collectTurn.mockImplementationOnce(async () => {
      h.setTurns([
        persistedTurn(),
        { ...persistedTurn(), id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sequence: 2 },
      ]);
      return {
        text: "transport answer",
        threadId: ids.thread,
        costCents: 1,
        messageId: ids.turn,
      };
    });

    const error = await h.controller
      .executePostmanTemplate(h.req, ids.template, h.body)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "POSTMAN_EXECUTION_EVIDENCE_UNAVAILABLE",
    });
  });

  it("keeps the real operator and only an opaque context handle across the session boundary", () => {
    const durableScope = buildSessionScope({
      ...scope,
      userId: "customer-external-42",
      operatorUserId: ids.operator,
      sessionContextHandle: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sessionContext: { sentinel: "OVERRIDE_SECRET_SENTINEL" },
    });

    expect(durableScope).toMatchObject({
      userId: "customer-external-42",
      operatorUserId: ids.operator,
      sessionContextHandle: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(durableScope).not.toHaveProperty("sessionContext");
    expect(JSON.stringify(durableScope)).not.toContain("OVERRIDE_SECRET_SENTINEL");
  });

  it("suppresses handled context from inspector output and identity persistence", () => {
    const agentService = readFileSync(
      resolve(process.cwd(), "src/agent-runtime/agent.service.ts"),
      "utf8",
    );
    const agentTaskService = readFileSync(
      resolve(process.cwd(), "src/agent-runtime/agent-task.service.ts"),
      "utf8",
    );

    expect(agentService).toContain("sessionContext: scope.sessionContextHandle");
    expect(agentService).toContain("? undefined");
    expect(agentTaskService).toContain("if (!scope.sessionContextHandle && scope.userId && scope.sessionContext)");
  });
});
