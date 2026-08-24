import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";
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

function harness(role: "OWNER" | "ADMIN" | "MEMBER" | null = "OWNER") {
  const idempotencyKey = `postman:${ids.template}:${ids.request}`;
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
    thread: {
      findFirst: vi.fn().mockResolvedValue({ id: ids.thread }),
    },
    turn: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([
        {
          id: ids.turn,
          threadId: ids.thread,
          sequence: 1,
          status: "SUCCEEDED",
          idempotencyKey,
          inputText: "hello",
          outputText: "persisted answer",
          createdAt: new Date("2026-08-24T12:00:00.000Z"),
          completedAt: new Date("2026-08-24T12:00:01.000Z"),
        },
      ]),
    },
  };
  const dispatch = {
    collectTurn: vi.fn().mockResolvedValue({
      text: "transport answer",
      threadId: ids.thread,
      costCents: 1,
      messageId: ids.turn,
    }),
  };
  const controller: any = Object.create(AgentController.prototype);
  controller.agentService = { prisma };
  controller.dispatch = dispatch;
  return {
    controller,
    dispatch,
    prisma,
    req: { scope } as any,
    body: {
      message: " hello ",
      requestId: ids.request,
      sessionContextOverride: { account: "one-turn", sentinel: "OVERRIDE_SECRET_SENTINEL" },
    },
  };
}

describe("AgentController executable Postman mode", () => {
  it.each(["OWNER", "ADMIN"] as const)(
    "executes one source-backed Turn for an Organization %s and reads it back",
    async (role) => {
      const h = harness(role);

      const result = await h.controller.executePostmanTemplate(
        h.req,
        ids.template,
        h.body,
      );

      expect(h.dispatch.collectTurn).toHaveBeenCalledTimes(1);
      expect(h.dispatch.collectTurn).toHaveBeenCalledWith(ids.agent, {
        scope: expect.objectContaining({
          organizationId: ids.organization,
          projectId: ids.project,
          environmentId: ids.environment,
          agentId: ids.agent,
          userId: "customer-external-42",
          operatorUserId: ids.operator,
          principal: "operator",
          sessionContext: {
            account: "one-turn",
            locale: "en",
            sentinel: "OVERRIDE_SECRET_SENTINEL",
          },
        }),
        message: "hello",
        idempotencyKey: `postman:${ids.template}:${ids.request}`,
      });
      expect(h.prisma.turn.findMany).toHaveBeenCalledTimes(1);
      expect(result.execution).toMatchObject({
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

  it("recovers an idempotent persisted Turn without a second dispatch", async () => {
    const h = harness("OWNER");
    h.prisma.turn.findFirst.mockResolvedValue({ threadId: ids.thread });

    const result = await h.controller.executePostmanTemplate(
      h.req,
      ids.template,
      h.body,
    );

    expect(h.dispatch.collectTurn).not.toHaveBeenCalled();
    expect(result.execution).toMatchObject({
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      turnCount: 1,
      recovered: true,
    });
  });

  it("fails closed when read-back does not prove exactly one matching Turn", async () => {
    const h = harness("OWNER");
    h.prisma.turn.findMany.mockResolvedValue([
      ...await h.prisma.turn.findMany(),
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sequence: 2 },
    ]);

    const error = await h.controller
      .executePostmanTemplate(h.req, ids.template, h.body)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "POSTMAN_EXECUTION_EVIDENCE_UNAVAILABLE",
    });
  });

  it("keeps the real Postman operator across the durable session boundary", () => {
    expect(buildSessionScope({
      ...scope,
      userId: "customer-external-42",
      operatorUserId: ids.operator,
      sessionContext: { account: "one-turn" },
    })).toMatchObject({
      userId: "customer-external-42",
      operatorUserId: ids.operator,
      sessionContext: { account: "one-turn" },
    });
  });
});
