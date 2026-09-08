import { describe, expect, it, vi } from "vitest";
import { jobInvocationProperty } from "./job-persistence";
import { JobStore } from "./job-store";
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
  // WIN-258 T6: the REAL JobStore over a fake client, so the scope
  // predicate, the shared filter and the row->record projection are inside the
  // system under test rather than replaced by the double.
  const controller = new JobsController(new JobStore(prisma as any), authService as any);
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

/**
 * WIN-258 T6 — two guards the suite above could not see, found by mutation.
 *
 * Both of these survived the first mutation sweep of this tranche. The suite
 * above establishes that every handler is operator-gated and that the CANONICAL
 * scope reaches the query rather than the requested one — but it asserts on the
 * serialized calls as a blob, so it never noticed WHICH predicate each call
 * carried. Two edits to `JobStore` therefore left it entirely green:
 *
 *   - the paginated count taking a DIFFERENT `where` than the page it counts;
 *   - `findDispatchable` losing `status: "ACTIVE"`.
 *
 * The first is the same wider-total bug the file browser has a guard for, on a
 * surface that had none. The second is worse than a wrong number: it dispatches
 * a job the operator cancelled or that failed to parse.
 *
 * A surviving mutation is a missing test, not a tolerable one, so these are the
 * tests rather than a ledger entry excusing them.
 */
describe("JobStore predicates the blob assertion could not see", () => {
  it("counts with the same predicate it pages, filter included", async () => {
    const { controller, prisma } = makeHarness();

    await controller.list(request(), undefined, "25", "10", "summary", "ACTIVE");

    const page = prisma.job.findMany.mock.calls[0]![0] as { where: unknown };
    const count = prisma.job.count.mock.calls[0]![0] as { where: unknown };
    // A JOIN between the two calls, holding no expected predicate of its own —
    // so it cannot drift as the filter grows, and it goes red the moment the
    // page and the total stop being built from one expression.
    expect(count.where).toEqual(page.where);
    // Non-vacuous: the shared predicate really did carry both filters.
    expect(JSON.stringify(page.where)).toContain("summary");
    expect(JSON.stringify(page.where)).toContain("ACTIVE");
  });

  it("refuses to dispatch a job that is not ACTIVE", async () => {
    const { controller, prisma } = makeHarness();
    prisma.job.findFirst.mockImplementation(async ({ where }: any) =>
      where.status === "ACTIVE" ? null : { id: JOB.id, externalId: JOB.externalId, displayName: JOB.displayName },
    );

    // The fake answers only when the ACTIVE filter is ABSENT. A store that
    // dropped it would find the row and dispatch; the store that keeps it finds
    // nothing and the transport 404s.
    await expect(controller.dispatch(request(), JOB.id, {})).rejects.toMatchObject({ status: 404 });
    expect(prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "ACTIVE" }) }),
    );
  });
});
