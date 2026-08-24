import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BudgetAlertDeliveryError,
  BudgetService,
  type BudgetStatus,
} from "./budget.service";
import type { BudgetAlertPayload } from "./budget-alert.types";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
};

const payload: BudgetAlertPayload = {
  eventId: "event-a",
  capId: "budget-a",
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  scopeType: "scope",
  targetId: "",
  period: "month",
  threshold: 80,
  limitCents: 10_000,
  spentCents: 8_000,
  runs: 10,
  runsLimit: 0,
  windowKey: "2026-08",
  subjectLabel: "Scope-wide",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("durable budget alert delivery", () => {
  it("rejects a stale worker finalization after a newer fenced claim wins", async () => {
    const retries: unknown[] = [];
    const state = {
      status: "PROCESSING",
      claimToken: "new-token",
      claimGeneration: 2,
      retryCount: 2,
      lastErrorCode: null as string | null,
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: any) => unknown) => callback({
        alertDelivery: {
          updateMany: vi.fn(async ({ where, data }: any) => {
            if (
              state.status !== where.status ||
              state.claimToken !== where.claimToken ||
              state.claimGeneration !== where.claimGeneration ||
              state.retryCount !== where.retryCount
            ) return { count: 0 };
            Object.assign(state, data);
            return { count: 1 };
          }),
        },
        alertDeliveryRetry: { create: vi.fn(async ({ data }: any) => retries.push(data)) },
      })),
    };
    const service = new BudgetService(prisma as any, {} as any);
    await expect((service as any).finishDeliveryRetry(
      "delivery-a",
      "env-a",
      "stale-token",
      1,
      1,
      { ok: true, statusCode: 200, errorCode: null, errorMessage: null },
    )).resolves.toBe(false);
    expect(state).toMatchObject({
      status: "PROCESSING",
      claimToken: "new-token",
      claimGeneration: 2,
      retryCount: 2,
      lastErrorCode: null,
    });
    expect(retries).toEqual([]);
  });

  it("creates one durable event and one delivery per eligible channel", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const tx = {
      budgetThresholdEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-a", threshold: 80 }),
      },
      alertChannel: {
        findMany: vi.fn().mockResolvedValue([{ id: "channel-a" }, { id: "channel-b" }]),
      },
      alertDelivery: { createMany },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new BudgetService(prisma as any, {} as any);
    const status = {
      cap: {
        id: "budget-a",
        alertThresholds: [80],
      },
      windowKey: "2026-08",
      spentCents: 8_000,
      runs: 10,
      percent: 80,
      runsPercent: 0,
    } as BudgetStatus;

    await expect(service.detectThresholdCrossings(scope, status)).resolves.toEqual([
      { id: "event-a", threshold: 80 },
    ]);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          environmentId: "env-a",
          channelId: "channel-a",
          budgetThresholdEventId: "event-a",
          kind: "BUDGET",
          idempotencyKey: "budget:event-a:channel-a",
        },
        {
          environmentId: "env-a",
          channelId: "channel-b",
          budgetThresholdEventId: "event-a",
          kind: "BUDGET",
          idempotencyKey: "budget:event-a:channel-b",
        },
      ],
      skipDuplicates: true,
    });

    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "P2002" }));
    await expect(service.detectThresholdCrossings(scope, status)).resolves.toEqual([]);
  });

  it("fails visibly on partial delivery and never redelivers a committed success", async () => {
    const rows = [
      deliveryRow("delivery-slack", "channel-slack", "SLACK", {
        credentialId: "credential-slack",
        slackChannelId: "C123",
      }),
      deliveryRow("delivery-email", "channel-email", "EMAIL", {
        email: "alerts@example.test",
      }),
    ];
    const retries: Array<Record<string, unknown>> = [];
    const prisma = {
      environment: {
        findUnique: vi.fn().mockResolvedValue({
          id: "env-a",
          archivedAt: null,
          project: {
            id: "project-a",
            archivedAt: null,
            organizationId: "org-a",
            organization: { archivedAt: null },
          },
        }),
      },
      budgetThresholdEvent: { findFirst: vi.fn().mockResolvedValue({ id: "event-a" }) },
      alertDelivery: {
        findMany: vi.fn(async () => rows),
        findFirstOrThrow: vi.fn(async ({ where }: any) => {
          const row = rows.find((candidate) => candidate.id === where.id)!;
          if (row.claimToken !== where.claimToken) throw new Error("claim unavailable");
          return { retryCount: row.retryCount, claimGeneration: row.claimGeneration };
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const row = rows.find((candidate) => candidate.id === where.id)!;
          if (row.status === "SUCCEEDED" || row.availableAt.getTime() > Date.now()) return { count: 0 };
          row.status = data.status;
          row.availableAt = data.availableAt;
          row.lastRetryAt = data.lastRetryAt;
          row.claimToken = data.claimToken;
          row.claimGeneration += 1;
          row.retryCount += 1;
          return { count: 1 };
        }),
      },
      $transaction: vi.fn(async (callback: (client: any) => unknown) => callback({
        alertDelivery: {
          updateMany: vi.fn(async ({ where, data }: any) => {
            const row = rows.find((candidate) => candidate.id === where.id)!;
            if (
              row.status !== where.status ||
              row.claimToken !== where.claimToken ||
              row.claimGeneration !== where.claimGeneration ||
              row.retryCount !== where.retryCount
            ) return { count: 0 };
            Object.assign(row, data);
            return { count: 1 };
          }),
        },
        alertDeliveryRetry: {
          create: vi.fn(async ({ data }: any) => {
            retries.push(data);
            return data;
          }),
        },
      })),
    };
    const secretStore = {
      readForRuntime: vi.fn().mockResolvedValue({ reveal: () => "sentinel-slack-token" }),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ ok: true }),
      })
      .mockResolvedValue({ ok: false, status: 503, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal("fetch", fetchMock);
    const scopedEnv = {
      get: vi.fn(async (_scope, name: string) => name === "RESEND_API_KEY" ? "sentinel-resend-key" : "alerts@example.test"),
    };
    const service = new BudgetService(
      prisma as any,
      {} as any,
      undefined,
      secretStore as any,
      scopedEnv as any,
    );

    let firstFailure: BudgetAlertDeliveryError | undefined;
    try {
      await service.deliverThresholdEvent(payload);
    } catch (error) {
      firstFailure = error as BudgetAlertDeliveryError;
    }
    expect(firstFailure).toBeInstanceOf(BudgetAlertDeliveryError);
    expect(firstFailure?.summary).toMatchObject({ delivered: 1, failed: 1, skipped: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows[0]).toMatchObject({ status: "SUCCEEDED", retryCount: 1 });
    expect(rows[1]).toMatchObject({
      status: "FAILED",
      retryCount: 1,
      lastErrorCode: "email_api_error",
    });
    expect(JSON.stringify(rows)).not.toContain("sentinel-slack-token");

    rows[1].availableAt = new Date(Date.now() - 1);
    await expect(service.deliverThresholdEvent(payload)).rejects.toMatchObject({
      summary: { delivered: 0, failed: 1, skipped: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rows[0].retryCount).toBe(1);
    expect(rows[1].retryCount).toBe(2);
    expect(retries.map((retry) => retry.deliveryId)).toEqual([
      "delivery-slack",
      "delivery-email",
      "delivery-email",
    ]);
  });
});

function deliveryRow(
  id: string,
  channelId: string,
  type: "EMAIL" | "SLACK" | "WEBHOOK",
  configuration: Record<string, unknown>,
) {
  return {
    id,
    environmentId: "env-a",
    channelId,
    budgetThresholdEventId: "event-a",
    status: "PENDING",
    retryCount: 0,
    claimGeneration: 0,
    claimToken: null as string | null,
    availableAt: new Date(0),
    lastRetryAt: null as Date | null,
    deliveredAt: null as Date | null,
    lastStatusCode: null as number | null,
    lastErrorCode: null as string | null,
    lastErrorMessage: null as string | null,
    createdAt: new Date(0),
    channel: {
      id: channelId,
      type,
      enabled: true,
      configuration,
    },
  };
}
