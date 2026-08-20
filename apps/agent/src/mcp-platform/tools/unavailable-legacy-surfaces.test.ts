import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../../auth/scope.guard";
import { buildAlertChannelToolHandlers } from "./alert_channels";
import { buildMonitoringToolHandlers } from "./monitoring";
import { buildSettingsToolHandlers } from "./settings";

const scope: RequestScope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "user-a",
  principal: "operator",
};

describe("canonical WIN-124 MCP surfaces", () => {
  it("lists Environment-owned alert channels without touching legacy delegates", async () => {
    const alertChannel = { findMany: vi.fn().mockResolvedValue([]) };
    const projectAlertChannel = { findMany: vi.fn() };
    const organizationIntegration = { findFirst: vi.fn() };
    const toolAudit = { record: vi.fn() };
    const handlers = buildAlertChannelToolHandlers({
      toolAudit: toolAudit as any,
      prisma: {
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
        organizationMembership: {
          findUnique: vi.fn().mockResolvedValue({ id: "membership-a", role: "ADMIN", deactivatedAt: null }),
        },
        projectMembership: { findUnique: vi.fn().mockResolvedValue(null) },
        alertChannel,
        projectAlertChannel,
        organizationIntegration,
      },
      secretStore: {} as any,
    });
    const handler = handlers.find((candidate) => candidate.name === "alert_channels.list")!;

    const result = await handler.execute({}, scope, {} as any);

    expect(result).toEqual({ channels: [] });
    expect(alertChannel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ environmentId: "env-a" }),
    }));
    expect(projectAlertChannel.findMany).not.toHaveBeenCalled();
    expect(organizationIntegration.findFirst).not.toHaveBeenCalled();
    expect(toolAudit.record).not.toHaveBeenCalled();
  });

  it("creates a webhook channel with Credential-backed secret material and a redacted result", async () => {
    const createdAt = new Date("2026-08-19T00:00:00.000Z");
    const create = vi.fn(async ({ data }: any) => ({
      id: data.id,
      environmentId: data.environmentId,
      type: data.type,
      name: data.name,
      enabled: true,
      alertTypes: data.alertTypes,
      deduplicationKey: null,
      userProvidedDeduplicationKey: false,
      createdAt,
      updatedAt: createdAt,
      configuration: {
        webhookUrl: data.configuration.create.webhookUrl,
        credentialId: data.configuration.create.credentialId,
      },
      deliveries: [],
    }));
    const prisma = canonicalOperatorPrisma({
      $transaction: vi.fn(async (callback: (tx: any) => unknown) => callback({
        alertChannel: { create },
      })),
    });
    const secretStore = {
      createInTransaction: vi.fn().mockResolvedValue({ id: "credential-a" }),
    };
    const toolAudit = { record: vi.fn().mockResolvedValue(undefined) };
    const handlers = buildAlertChannelToolHandlers({
      toolAudit: toolAudit as any,
      prisma,
      secretStore: secretStore as any,
    });
    const handler = handlers.find((candidate) => candidate.name === "alert_channels.create")!;
    expect(handler.macroRecordable).toBe(false);
    expect(
      handlers.find((candidate) => candidate.name === "alert_channels.update")?.macroRecordable,
    ).toBe(false);

    const result = await handler.execute(
      {
        type: "WEBHOOK",
        name: "Budget webhook",
        alertTypes: ["BUDGET"],
        channel: {
          url: "https://8.8.8.8/hooks/budget",
          secret: "sentinel-webhook-secret",
        },
      },
      scope,
      {} as any,
    );

    expect(result).toMatchObject({
      type: "WEBHOOK",
      name: "Budget webhook",
      properties: {
        url: "https://8.8.8.8/hooks/budget",
        hasSecret: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("sentinel-webhook-secret");
    expect(secretStore.createInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        plaintext: "sentinel-webhook-secret",
        kind: "CHANNEL_SECRET",
      }),
    );
    expect(create.mock.calls[0][0].data.configuration.create).toEqual({
      webhookUrl: "https://8.8.8.8/hooks/budget",
      credentialId: "credential-a",
    });
    expect(JSON.stringify(toolAudit.record.mock.calls)).not.toContain("sentinel-webhook-secret");
  });

  it("soft-deletes a channel without removing its durable delivery ledger", async () => {
    const update = vi.fn().mockResolvedValue({ id: "channel-a" });
    const revokeInTransaction = vi.fn().mockResolvedValue(undefined);
    const tx = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: "credential-a" }]),
      alertChannel: { update },
      alertChannelConfiguration: { count: vi.fn().mockResolvedValue(0) },
    };
    const prisma = canonicalOperatorPrisma({
      alertChannel: {
        findFirst: vi.fn().mockResolvedValue({
          id: "channel-a",
          type: "WEBHOOK",
          name: "Budget webhook",
          configuration: { credentialId: "credential-a" },
        }),
      },
      $transaction: vi.fn(async (callback: (client: any) => unknown) => callback(tx)),
    });
    const handlers = buildAlertChannelToolHandlers({
      toolAudit: { record: vi.fn().mockResolvedValue(undefined) } as any,
      prisma,
      secretStore: { revokeInTransaction } as any,
    });
    const handler = handlers.find((candidate) => candidate.name === "alert_channels.delete")!;

    await expect(handler.execute({ id: "channel-a" }, scope, {} as any)).resolves.toEqual({
      deleted: true,
      id: "channel-a",
      type: "WEBHOOK",
      name: "Budget webhook",
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "channel-a" },
      data: {
        enabled: false,
        deletedAt: expect.any(Date),
        deduplicationKey: null,
        userProvidedDeduplicationKey: false,
      },
    });
    expect(tx.alertChannelConfiguration.count).toHaveBeenCalledWith({
      where: {
        credentialId: "credential-a",
        channel: { deletedAt: null, enabled: true },
      },
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT "id" FROM "Credential" WHERE "id" = $1::uuid FOR UPDATE',
      "credential-a",
    );
    expect(revokeInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ credentialId: "credential-a" }),
    );
  });

  it("persists webhook test credential failures as terminal delivery attempts", async () => {
    const attemptCreate = vi.fn().mockResolvedValue({ id: "attempt-a" });
    const deliveryUpdate = vi.fn().mockResolvedValue({
      id: "delivery-a",
      status: "FAILED",
      attemptCount: 1,
      deliveredAt: null,
      lastStatusCode: null,
      lastErrorCode: "credential_unavailable",
      lastErrorMessage: "Webhook credential is unavailable",
    });
    const prisma = canonicalOperatorPrisma({
      alertChannel: {
        findFirst: vi.fn().mockResolvedValue({
          id: "channel-a",
          environmentId: "env-a",
          type: "WEBHOOK",
          name: "Budget webhook",
          enabled: true,
          configuration: {
            webhookUrl: "https://8.8.8.8/hooks/budget",
            credentialId: "credential-a",
          },
        }),
      },
      alertDelivery: {
        create: vi.fn().mockResolvedValue({ id: "delivery-a", environmentId: "env-a" }),
      },
      $transaction: vi.fn(async (callback: (tx: any) => unknown) => callback({
        alertDelivery: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ attemptCount: 0 }),
          update: deliveryUpdate,
        },
        alertDeliveryAttempt: { create: attemptCreate },
      })),
    });
    const handlers = buildAlertChannelToolHandlers({
      toolAudit: { record: vi.fn().mockResolvedValue(undefined) } as any,
      prisma,
      secretStore: {
        readForRuntime: vi.fn().mockRejectedValue(new Error("sentinel-decrypt-detail")),
      } as any,
    });
    const handler = handlers.find((candidate) => candidate.name === "alert_channels.test")!;

    const result = await handler.execute({ id: "channel-a" }, scope, {} as any);

    expect(result).toMatchObject({
      ok: false,
      error: "credential_unavailable",
      message: "Webhook credential is unavailable",
      delivery: { status: "FAILED", attemptCount: 1 },
    });
    expect(attemptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        environmentId: "env-a",
        deliveryId: "delivery-a",
        attemptNumber: 1,
        status: "FAILED",
        errorCode: "credential_unavailable",
        errorMessage: "Webhook credential is unavailable",
      }),
    });
    expect(JSON.stringify(result)).not.toContain("sentinel-decrypt-detail");
  });

  it("sets an Environment secret without including plaintext in audit payloads", async () => {
    const envs = {
      listSecrets: vi.fn(),
      setSecret: vi.fn().mockResolvedValue({ ok: true, name: "API_KEY", version: "1" }),
      deleteSecret: vi.fn(),
    };
    const toolAudit = { record: vi.fn().mockResolvedValue(undefined) };
    const handlers = buildSettingsToolHandlers({
      orgs: {} as any,
      envs: envs as any,
      clusters: {} as any,
      toolAudit: toolAudit as any,
      prisma: {} as any,
    });
    const handler = handlers.find((candidate) => candidate.name === "environments.set_secret")!;
    expect(handler.macroRecordable).toBe(false);

    const result = await handler.execute(
      { name: "API_KEY", value: "sentinel-plaintext-secret" },
      scope,
      {} as any,
    );

    expect(result).toEqual({ ok: true, name: "API_KEY", version: "1" });
    expect(JSON.stringify(result)).not.toContain("sentinel");
    expect(envs.listSecrets).not.toHaveBeenCalled();
    expect(envs.setSecret).toHaveBeenCalledWith(
      { organizationId: "org-a", projectId: "project-a", environmentId: "env-a" },
      "user-a",
      { name: "API_KEY", value: "sentinel-plaintext-secret" },
    );
    expect(envs.deleteSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(toolAudit.record.mock.calls)).not.toContain("sentinel-plaintext-secret");
  });
});

function canonicalOperatorPrisma(extra: Record<string, unknown> = {}) {
  return {
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
    organizationMembership: {
      findUnique: vi.fn().mockResolvedValue({
        id: "membership-a",
        role: "ADMIN",
        deactivatedAt: null,
      }),
    },
    projectMembership: { findUnique: vi.fn().mockResolvedValue(null) },
    ...extra,
  };
}

describe("canonical run-history absence", () => {
  it("returns a stable unavailable response without querying TaskRun", async () => {
    const findMany = vi.fn();
    const handlers = buildMonitoringToolHandlers({
      traces: {} as any,
      providerHealth: {} as any,
      prisma: { taskRun: { findMany } },
    });
    const handler = handlers.find((candidate) => candidate.name === "runs.list_all")!;

    const result = await handler.execute(
      { taskIdentifier: "sentinel-task", limit: 10 },
      scope,
      {} as any,
    );

    expect(result).toEqual({
      error: "unavailable",
      message: "Task run history is not available through the canonical control database.",
    });
    expect(findMany).not.toHaveBeenCalled();
  });
});
