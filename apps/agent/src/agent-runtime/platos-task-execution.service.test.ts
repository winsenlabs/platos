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

  it.each([
    'async function run() { return Object.constructor("return process")().versions.node; }',
    'async function run(_payload, ctx) { return ctx.fetch.constructor("return process")().versions.node; }',
    'async function run(payload) { return payload.constructor.constructor("return process")().versions.node; }',
  ])("blocks registered handlers from recovering host constructors", async (handler) => {
    prisma.job.findFirst.mockResolvedValue(task({ handler }));

    const result = await service.execute(request);

    expect(result).toEqual({
      httpStatus: 500,
      body: { status: "failed", error: { code: "TASK_EXECUTION_FAILED" } },
    });
    expect(JSON.stringify(result)).not.toContain(process.versions.node);
  });

  it.each([
    ["a public destination", 'await ctx.fetch("https://upstream.example")'],
    ["a private destination", 'await ctx.fetch("http://127.0.0.1:3000/internal")'],
    [
      "a redirect-capable destination",
      'await ctx.fetch("https://upstream.example/redirect", { redirect: "follow" })',
    ],
    [
      "sensitive header smuggling",
      'await ctx.fetch("https://upstream.example", { headers: { authorization: "smuggled" } })',
    ],
  ])("provides no network capability for %s", async (_description, attemptedFetch) => {
    prisma.job.findFirst.mockResolvedValue(
      task({ handler: `async function run(_payload, ctx) { ${attemptedFetch}; }` })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.execute(request);

    expect(result).toEqual({
      httpStatus: 500,
      body: { status: "failed", error: { code: "TASK_EXECUTION_FAILED" } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("enforces invocation type and the registered agent allowlist", async () => {
    prisma.job.findFirst.mockResolvedValue(
      task({ triggerType: "agent-spawn", allowedAgentIds: ["agent-allowed"] })
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

  it("persists and replays the exact bounded validated result", async () => {
    const first = await service.execute(request);
    const second = await service.execute(request);

    expect(first.body).toMatchObject({ status: "completed", result: { echo: "safe-input" } });
    expect(second).toEqual({
      httpStatus: 200,
      body: { status: "completed", result: { echo: "safe-input" }, replayed: true },
    });
    expect(prisma.job.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.job.updateMany).toHaveBeenCalledOnce();
    const persisted = JSON.parse([...redis.values.values()][0]!) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      state: "completed",
      result: { echo: "safe-input" },
    });
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
      "postgresql://writer:secret@db.internal/platos handler source sentinel"
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

  it("terminates an asynchronous infinite loop and keeps the parent execution service healthy", async () => {
    prisma.job.findFirst.mockResolvedValue(
      task({
        handler: "async function run() { while (true) { await Promise.resolve(); } }",
        timeoutSeconds: 1,
      })
    );

    const startedAt = Date.now();
    const result = await service.execute(request);

    expect(result).toEqual({
      httpStatus: 504,
      body: { status: "failed", error: { code: "TASK_TIMEOUT" } },
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    prisma.job.findFirst.mockResolvedValue(task());
    const subsequent = await service.execute({ ...request, requestId: "run-after-timeout" });
    expect(subsequent).toEqual({
      httpStatus: 200,
      body: { status: "completed", result: { echo: "safe-input" } },
    });
  });

  it("bounds synchronous registered code and maps VM cancellation to the timeout code", async () => {
    prisma.job.findFirst.mockResolvedValue(
      task({ handler: "function run() { while (true) {} }", timeoutSeconds: 1 })
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
        handler: "async function run() { return { authorization: 'Bearer credential-sentinel' }; }",
      })
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

  it.each([
    [
      "results over 64 KB",
      'async function run() { return Array.from({ length: 100 }, (_, index) => "x".repeat(700) + index); }',
    ],
    [
      "results deeper than 8 levels",
      "async function run() { return { a: { b: { c: { d: { e: { f: { g: { h: { i: true } } } } } } } } }; }",
    ],
    [
      "results with more than 100 collection items",
      "async function run() { return Array.from({ length: 101 }, (_, index) => index); }",
    ],
  ])("rejects %s before idempotency persistence", async (_description, handler) => {
    prisma.job.findFirst.mockResolvedValue(task({ handler }));

    const result = await service.execute(request);

    expect(result).toEqual({
      httpStatus: 422,
      body: { status: "failed", error: { code: "TASK_RESULT_REJECTED" } },
    });
    const persisted = [...redis.values.values()].join(" ");
    expect(persisted).toContain('"state":"failed"');
    expect(persisted).not.toContain('"result"');
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
