import { beforeEach, describe, expect, it, vi } from "vitest";

const mutations = vi.hoisted(() => ({
  prismaFind: vi.fn(),
  prismaWrite: vi.fn(),
  idempotencyRead: vi.fn(),
  idempotencyWrite: vi.fn(),
  objectStoreRead: vi.fn(),
  objectStoreWrite: vi.fn(),
  runEngineBatchConstructed: vi.fn(),
  createBatchConstructed: vi.fn(),
  streamBatchItemsConstructed: vi.fn(),
  streamBatchItemsCall: vi.fn(),
  createNdjsonParserStream: vi.fn(),
  streamToAsyncIterable: vi.fn(),
  engineCall: vi.fn(),
}));

vi.mock("~/env.server", () => ({
  env: { BATCH_TASK_PAYLOAD_MAXIMUM_SIZE: 128_000 },
}));

vi.mock("~/services/routeBuilders/apiBuilder.server", () => ({
  createActionApiRoute: vi.fn((_options, callback) => ({
    action: callback,
    loader: vi.fn(),
  })),
}));

vi.mock("~/db.server", () => ({
  $replica: {},
  prisma: {
    batchTaskRun: {
      findFirst: mutations.prismaFind,
      create: mutations.prismaWrite,
      update: mutations.prismaWrite,
      updateMany: mutations.prismaWrite,
    },
    $transaction: mutations.prismaWrite,
  },
}));

vi.mock("~/utils/requestIdempotency.server", () => ({
  handleRequestIdempotency: mutations.idempotencyRead,
  saveRequestIdempotency: mutations.idempotencyWrite,
}));

vi.mock("~/v3/objectStore.server", () => ({
  downloadPacketFromObjectStore: mutations.objectStoreRead,
  uploadPacketToObjectStore: mutations.objectStoreWrite,
}));

vi.mock("~/runEngine/services/batchTrigger.server", () => ({
  RunEngineBatchTriggerService: class {
    constructor() {
      mutations.runEngineBatchConstructed();
    }
  },
}));

vi.mock("~/runEngine/services/createBatch.server", () => ({
  CreateBatchService: class {
    constructor() {
      mutations.createBatchConstructed();
    }
  },
}));

vi.mock("~/runEngine/services/streamBatchItems.server", () => ({
  StreamBatchItemsService: class {
    constructor() {
      mutations.streamBatchItemsConstructed();
    }

    call(...args: unknown[]) {
      return mutations.streamBatchItemsCall(...args);
    }
  },
  createNdjsonParserStream: mutations.createNdjsonParserStream,
  streamToAsyncIterable: mutations.streamToAsyncIterable,
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: { trigger: mutations.engineCall },
}));

import { action as v2BatchAction } from "~/routes/api.v2.tasks.batch";
import { action as v3BatchAction } from "~/routes/api.v3.batches";
import { action as v3BatchItemsAction } from "~/routes/api.v3.batches.$batchId.items";
import { DeleteTaskScheduleService } from "~/v3/services/deleteTaskSchedule.server";
import { SetActiveOnTaskScheduleService } from "~/v3/services/setActiveOnTaskSchedule.server";
import { UpsertTaskScheduleService } from "~/v3/services/upsertTaskSchedule.server";

describe("external Trigger batch boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["api.v2.tasks.batch", v2BatchAction],
    ["api.v3.batches", v3BatchAction],
  ])("rejects %s before any local mutation", async (_route, action) => {
    const response = await action({} as never);

    expect(response.status).toBe(409);
    expect(response.headers.get("x-should-retry")).toBe("false");
    await expect(response.json()).resolves.toEqual({
      error: { code: "EXTERNAL_TRIGGER_REQUIRED" },
    });
    expect(mutations.prismaFind).not.toHaveBeenCalled();
    expect(mutations.prismaWrite).not.toHaveBeenCalled();
    expect(mutations.idempotencyRead).not.toHaveBeenCalled();
    expect(mutations.idempotencyWrite).not.toHaveBeenCalled();
    expect(mutations.objectStoreRead).not.toHaveBeenCalled();
    expect(mutations.objectStoreWrite).not.toHaveBeenCalled();
    expect(mutations.runEngineBatchConstructed).not.toHaveBeenCalled();
    expect(mutations.createBatchConstructed).not.toHaveBeenCalled();
    expect(mutations.engineCall).not.toHaveBeenCalled();
  });

  it.each([
    ["small", { task: "task-a", payload: JSON.stringify({ value: "safe" }), index: 0 }],
    [
      "large",
      { task: "task-a", payload: JSON.stringify({ value: "x".repeat(64 * 1024) }), index: 0 },
    ],
  ])(
    "rejects a %s valid streamed item before service, storage, or database access",
    async (_size, item) => {
      const request = new Request("http://localhost/api/v3/batches/batch-a/items", {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: `${JSON.stringify(item)}\n`,
      });

      const response = await v3BatchItemsAction({
        request,
        params: { batchId: "batch-a" },
        context: {},
      });

      expect(response.status).toBe(409);
      expect(response.headers.get("x-should-retry")).toBe("false");
      await expect(response.json()).resolves.toEqual({
        error: { code: "EXTERNAL_TRIGGER_REQUIRED" },
      });
      expect(mutations.streamBatchItemsConstructed).not.toHaveBeenCalled();
      expect(mutations.streamBatchItemsCall).not.toHaveBeenCalled();
      expect(mutations.createNdjsonParserStream).not.toHaveBeenCalled();
      expect(mutations.streamToAsyncIterable).not.toHaveBeenCalled();
      expect(mutations.prismaFind).not.toHaveBeenCalled();
      expect(mutations.prismaWrite).not.toHaveBeenCalled();
      expect(mutations.idempotencyRead).not.toHaveBeenCalled();
      expect(mutations.idempotencyWrite).not.toHaveBeenCalled();
      expect(mutations.objectStoreRead).not.toHaveBeenCalled();
      expect(mutations.objectStoreWrite).not.toHaveBeenCalled();
      expect(mutations.engineCall).not.toHaveBeenCalled();
    }
  );
});

describe("external Trigger schedule boundary", () => {
  const prisma = new Proxy(
    {},
    {
      get() {
        mutations.prismaWrite();
        throw new Error("local persistence must not be reached");
      },
    }
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      "upsert",
      () =>
        new UpsertTaskScheduleService(prisma as never).call("project-a", {
          taskIdentifier: "task-a",
          cron: "0 * * * *",
          environments: ["env-a"],
        }),
    ],
    [
      "delete",
      () =>
        new DeleteTaskScheduleService(prisma as never).call({
          projectId: "project-a",
          userId: "user-a",
          friendlyId: "schedule-a",
        }),
    ],
    [
      "activation",
      () =>
        new SetActiveOnTaskScheduleService(prisma as never).call({
          projectId: "project-a",
          userId: "user-a",
          friendlyId: "schedule-a",
          active: true,
        }),
    ],
  ])("rejects local schedule %s before persistence access", async (_operation, call) => {
    await expect(call()).rejects.toMatchObject({ code: "EXTERNAL_TRIGGER_REQUIRED" });
    expect(mutations.prismaWrite).not.toHaveBeenCalled();
  });
});
