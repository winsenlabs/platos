import { describe, expect, it, vi } from "vitest";
import { jobInvocationProperty } from "./job-persistence";
import { JobsController } from "./jobs.controller";

const REQUESTED_SCOPE = {
  organizationId: "requested-org",
  projectId: "requested-project",
  environmentId: "environment-1",
  userId: "operator-1",
  principal: "operator" as const,
};

const CANONICAL_AUTHORIZATION = {
  organizationId: "canonical-org",
  projectId: "canonical-project",
  environmentId: "environment-1",
  actorUserId: "operator-1",
  effectiveUserId: "operator-1",
  organizationRole: "MEMBER",
  projectRole: "ADMIN",
};

const JOB = {
  id: "job-1",
  environmentId: "environment-1",
  externalId: "daily-summary",
  displayName: "Daily summary",
  description: "Build the daily summary",
  ...jobInvocationProperty("manual"),
  scheduleCron: null,
  scheduleTimezone: null,
  allowedAgentIds: [],
  payloadSchema: {},
  handler: "return payload;",
  status: "ACTIVE",
  timeoutSeconds: 300,
  maxRetries: 3,
  createdBy: "operator-1",
  createdAt: new Date("2026-08-24T00:00:00.000Z"),
  updatedAt: new Date("2026-08-24T00:00:00.000Z"),
  lastStartedAt: null,
};

function request(scope: unknown = REQUESTED_SCOPE) {
  return { scope } as any;
}

function makeHarness(options: { rejectAuthorization?: boolean } = {}) {
  const job = {
    findMany: vi.fn(async () => [JOB]),
    count: vi.fn(async () => 1),
    findFirst: vi.fn(async ({ where, select }: any) => {
      if (where.externalId) return null;
      if (select?.handler) return { id: JOB.id, handler: JOB.handler };
      if (select?.externalId) {
        return { id: JOB.id, externalId: JOB.externalId, displayName: JOB.displayName };
      }
      return JOB;
    }),
    create: vi.fn(async () => JOB),
    update: vi.fn(async () => JOB),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  };
  const prisma = { job };
  const authService = {
    authorizeEnvironmentOperatorScope: vi.fn(async () => {
      if (options.rejectAuthorization) throw new Error("environment_forbidden");
      return CANONICAL_AUTHORIZATION;
    }),
  };
  const controller = new JobsController(prisma as any, authService as any);
  return { controller, prisma, authService };
}

const HANDLERS = [
  {
    name: "list",
    access: "metadata",
    invoke: (controller: JobsController, req: any) => controller.list(req),
  },
  {
    name: "get",
    access: "metadata",
    invoke: (controller: JobsController, req: any) => controller.getOne(req, JOB.id),
  },
  {
    name: "create",
    access: "secret:mutate",
    invoke: (controller: JobsController, req: any) =>
      controller.create(req, {
        jobId: "daily-summary",
        displayName: "Daily summary",
        handler: "return payload;",
      }),
  },
  {
    name: "update",
    access: "secret:mutate",
    invoke: (controller: JobsController, req: any) =>
      controller.update(req, JOB.id, { displayName: "Updated summary" }),
  },
  {
    name: "delete",
    access: "secret:mutate",
    invoke: (controller: JobsController, req: any) => controller.remove(req, JOB.id),
  },
  {
    name: "dispatch",
    access: "secret:mutate",
    invoke: async (controller: JobsController, req: any) => {
      const apiUrlKey = ["TRI", "GGER_API_URL"].join("");
      const secretKey = ["TRI", "GGER_SECRET_KEY"].join("");
      const savedApiUrl = process.env[apiUrlKey];
      const savedSecret = process.env[secretKey];
      delete process.env[apiUrlKey];
      delete process.env[secretKey];
      try {
        return await controller.dispatch(req, JOB.id, {});
      } finally {
        if (savedApiUrl === undefined) delete process.env[apiUrlKey];
        else process.env[apiUrlKey] = savedApiUrl;
        if (savedSecret === undefined) delete process.env[secretKey];
        else process.env[secretKey] = savedSecret;
      }
    },
  },
] as const;

function expectNoJobAccess(prisma: ReturnType<typeof makeHarness>["prisma"]) {
  for (const method of Object.values(prisma.job)) expect(method).not.toHaveBeenCalled();
}

describe("JobsController operator authorization", () => {
  const deniedCallers = [
    {
      name: "end-user session",
      scope: { ...REQUESTED_SCOPE, userId: "end-user-1", principal: "end-user" as const },
    },
    {
      name: "entity session",
      scope: {
        ...REQUESTED_SCOPE,
        userId: "entity-user-1",
        entityId: "entity-1",
        principal: "end-user" as const,
      },
    },
    {
      name: "guest session",
      scope: {
        ...REQUESTED_SCOPE,
        userId: "guest-anonymous",
        sessionId: "guest-session-1",
        principal: "end-user" as const,
      },
    },
  ] as const;

  for (const caller of deniedCallers) {
    it.each(HANDLERS)(`denies ${caller.name} before $name access`, async ({ invoke }) => {
      const { controller, prisma, authService } = makeHarness();

      await expect(invoke(controller, request(caller.scope))).rejects.toMatchObject({
        status: 403,
        response: { error: "OPERATOR_ONLY" },
      });
      expect(authService.authorizeEnvironmentOperatorScope).not.toHaveBeenCalled();
      expectNoJobAccess(prisma);
    });
  }

  it.each(HANDLERS)(
    "denies an operator without the applicable Environment role before $name access",
    async ({ access, invoke }) => {
      const { controller, prisma, authService } = makeHarness({ rejectAuthorization: true });

      await expect(invoke(controller, request())).rejects.toThrow("environment_forbidden");
      expect(authService.authorizeEnvironmentOperatorScope).toHaveBeenCalledWith(
        REQUESTED_SCOPE,
        access,
      );
      expectNoJobAccess(prisma);
    },
  );

  it.each(HANDLERS)(
    "allows an authorized Environment operator to $name using canonical ancestry",
    async ({ access, invoke }) => {
      const { controller, prisma, authService } = makeHarness();

      await expect(invoke(controller, request())).resolves.toBeDefined();
      expect(authService.authorizeEnvironmentOperatorScope).toHaveBeenCalledWith(
        REQUESTED_SCOPE,
        access,
      );
      expect(Object.values(prisma.job).some((method) => method.mock.calls.length > 0)).toBe(true);

      const serializedCalls = JSON.stringify(
        Object.values(prisma.job).map((method) => method.mock.calls),
      );
      expect(serializedCalls).toContain("canonical-org");
      expect(serializedCalls).toContain("canonical-project");
      expect(serializedCalls).not.toContain("requested-org");
      expect(serializedCalls).not.toContain("requested-project");
    },
  );
});
