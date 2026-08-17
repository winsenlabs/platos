import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePlatosTaskExecutionRequest,
  PlatosTaskExecutionService,
  type PlatosTaskExecutionRequest,
} from "./platos-task-execution.service";

const request: PlatosTaskExecutionRequest = {
  requestId: "run-a",
  taskRowId: "job-a",
  payload: { value: "safe-input" },
  scope: {
    organizationId: "org-a",
    projectId: "project-a",
    environmentId: "env-a",
    userId: "user-a",
  },
  invokedBy: "manual",
};

function redisMock() {
  const values = new Map<string, string>();
  return {
    values,
    set: vi.fn(async (key: string, value: string, ...args: string[]) => {
      if (args.includes("NX") && values.has(key)) return null;
      if (args.includes("XX") && !values.has(key)) return null;
      values.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    externalId: "registered-task",
    handler: "async function run(payload) { return { echo: payload.value }; }",
    timeoutSeconds: 5,
    triggerType: "manual",
    allowedAgentIds: [],
    ...overrides,
  };
}

describe("PlatosTaskExecutionService", () => {
  let prisma: any;
  let redis: ReturnType<typeof redisMock>;
  let service: PlatosTaskExecutionService;

  beforeEach(() => {
    prisma = {
      job: {
        findFirst: vi.fn().mockResolvedValue(task()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    redis = redisMock();
    service = new PlatosTaskExecutionService(prisma, redis as any);
  });

  it("looks up only an active registered task through canonical Environment ancestry", async () => {
    prisma.job.findFirst.mockResolvedValue(null);

    const result = await service.execute(request);

    expect(prisma.job.findFirst).toHaveBeenCalledWith({
      where: {
        id: "job-a",
        status: "ACTIVE",
        environmentId: "env-a",
        environment: {
          projectId: "project-a",
          project: { organizationId: "org-a" },
        },
      },
      select: {
        externalId: true,
        handler: true,
        timeoutSeconds: true,
        triggerType: true,
        allowedAgentIds: true,
      },
    });
    expect(result).toEqual({
      httpStatus: 404,
      body: { status: "failed", error: { code: "TASK_NOT_FOUND_OR_INACTIVE" } },
    });
  });

  it("executes only the stored registered handler and preserves the prior output behavior", async () => {
    const result = await service.execute(request);

    expect(result).toEqual({
      httpStatus: 200,
      body: { status: "completed", result: { echo: "safe-input" } },
    });
    expect(prisma.job.updateMany).toHaveBeenCalledOnce();
  });

  it("enforces invocation type and the registered agent allowlist", async () => {
    prisma.job.findFirst.mockResolvedValue(
      task({ triggerType: "agent-spawn", allowedAgentIds: ["agent-allowed"] }),
    );

    const result = await service.execute({
      ...request,
      invokedBy: "agent",
      agentId: "agent-denied",
    });

    expect(result.body).toEqual({
      status: "failed",
      error: { code: "TASK_NOT_AUTHORIZED" },
    });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("deduplicates a retry without persisting or replaying task output", async () => {
    const first = await service.execute(request);
    const second = await service.execute(request);

    expect(first.body).toMatchObject({ status: "completed", result: { echo: "safe-input" } });
    expect(second).toEqual({
      httpStatus: 200,
      body: { status: "completed", replayed: true },
    });
    expect(prisma.job.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.job.updateMany).toHaveBeenCalledOnce();
    const persisted = [...redis.values.values()].join(" ");
    expect(persisted).not.toContain("safe-input");
  });

  it("rejects idempotency-key reuse with different scoped arguments", async () => {
    await service.execute(request);

    const result = await service.execute({
      ...request,
      payload: { value: "different-safe-input" },
    });

    expect(result.body).toEqual({
      status: "failed",
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
    expect(prisma.job.updateMany).toHaveBeenCalledOnce();
  });

  it("fails closed when idempotency storage is unavailable", async () => {
    redis.set.mockRejectedValueOnce(new Error("redis://user:secret@internal"));

    const result = await service.execute(request);

    expect(result.body).toEqual({
      status: "failed",
      error: { code: "IDEMPOTENCY_UNAVAILABLE" },
    });
    expect(JSON.stringify(result)).not.toContain("redis://");
    expect(prisma.job.updateMany).not.toHaveBeenCalled();
  });

  it("discards database errors and returns a stable safe code", async () => {
    const sensitiveFailure = new Error(
      "postgresql://writer:secret@db.internal/platos handler source sentinel",
    );
    prisma.job.findFirst.mockRejectedValue(sensitiveFailure);

    const result = await service.execute(request);

    expect(result).toEqual({
      httpStatus: 503,
      body: { status: "failed", error: { code: "TASK_SERVICE_UNAVAILABLE" } },
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveFailure.message);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("aborts registered fetch work on the configured timeout and returns only a stable code", async () => {
    vi.useFakeTimers();
    prisma.job.findFirst.mockResolvedValue(
      task({
        handler: "async function run(_payload, ctx) { await ctx.fetch('https://upstream.invalid'); }",
        timeoutSeconds: 1,
      }),
    );
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("raw upstream body with credential sentinel")),
        );
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = service.execute(request);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result).toEqual({
      httpStatus: 504,
      body: { status: "failed", error: { code: "TASK_TIMEOUT" } },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("raw upstream body");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bounds synchronous registered code and maps VM cancellation to the timeout code", async () => {
    prisma.job.findFirst.mockResolvedValue(
      task({ handler: "function run() { while (true) {} }", timeoutSeconds: 1 }),
    );

    const result = await service.execute(request);

    expect(result).toEqual({
      httpStatus: 504,
      body: { status: "failed", error: { code: "TASK_TIMEOUT" } },
    });
  });

  it("rejects sensitive handler output instead of returning or storing it", async () => {
    prisma.job.findFirst.mockResolvedValue(
      task({
        handler:
          "async function run() { return { authorization: 'Bearer credential-sentinel' }; }",
      }),
    );

    const result = await service.execute(request);
    const serialized = JSON.stringify({ result, redis: [...redis.values.values()] });

    expect(result.body).toEqual({
      status: "failed",
      error: { code: "TASK_RESULT_REJECTED" },
    });
    expect(serialized).not.toContain("credential-sentinel");
    expect(serialized).not.toContain("authorization");
  });
});

describe("parsePlatosTaskExecutionRequest", () => {
  it("accepts the strict secret-free callback contract", () => {
    expect(parsePlatosTaskExecutionRequest(request)).toEqual(request);
  });

  it.each([
    { ...request, handler: "source supplied by Trigger" },
    { ...request, arbitraryTaskId: "not-registered" },
    { ...request, payload: { apiKey: "credential-sentinel" } },
    { ...request, payload: { internalAuthToken: "credential-sentinel" } },
    { ...request, payload: { handlerSource: "source supplied by Trigger" } },
    { ...request, payload: { nested: { password: "credential-sentinel" } } },
    { ...request, scope: { ...request.scope, forged: "ancestry" } },
  ])("rejects extra, executable, ancestry, and secret-bearing fields", (candidate) => {
    expect(parsePlatosTaskExecutionRequest(candidate)).toBeNull();
  });
});
