import { describe, expect, it, vi } from "vitest";
import { EnvironmentService } from "../../admin/environment.service";
import type { RequestScope } from "../../auth/scope.guard";
import type { ControlDatabaseClient } from "../../shared/database.provider";
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

const environmentUnavailable = {
  error: "unavailable",
  message:
    "Environment credential management is unavailable pending the canonical WIN-124 persistence cutover.",
};

const alertUnavailable = {
  error: "unavailable",
  message:
    "Alert channel management is unavailable pending the canonical WIN-124 persistence cutover.",
};

describe("paused WIN-124 MCP surfaces", () => {
  it.each([
    "alert_channels.list",
    "alert_channels.create",
    "alert_channels.update",
    "alert_channels.delete",
    "alert_channels.test",
    "alert_channels.get_integration",
  ])("fails closed for %s without persistence or secret handling", async (name) => {
    const projectAlertChannel = { findMany: vi.fn(), create: vi.fn(), update: vi.fn() };
    const organizationIntegration = { findFirst: vi.fn() };
    const toolAudit = { record: vi.fn() };
    const handlers = buildAlertChannelToolHandlers({
      toolAudit: toolAudit as any,
      prisma: { projectAlertChannel, organizationIntegration },
    });
    const handler = handlers.find((candidate) => candidate.name === name)!;

    const result = await handler.execute(
      {
        id: "channel-a",
        type: "WEBHOOK",
        name: "alerts",
        alertTypes: ["TASK_RUN"],
        channel: {
          url: "https://example.com/sentinel-url",
          secret: "sentinel-webhook-secret",
        },
      },
      scope,
      {} as any,
    );

    expect(result).toEqual(alertUnavailable);
    expect(JSON.stringify(result)).not.toContain("sentinel");
    expect(projectAlertChannel.findMany).not.toHaveBeenCalled();
    expect(projectAlertChannel.create).not.toHaveBeenCalled();
    expect(projectAlertChannel.update).not.toHaveBeenCalled();
    expect(organizationIntegration.findFirst).not.toHaveBeenCalled();
    expect(toolAudit.record).not.toHaveBeenCalled();
  });

  it.each([
    "environments.list_secrets",
    "environments.set_secret",
    "environments.delete_secret",
  ])("fails closed for %s before service calls or audit", async (name) => {
    const envs = {
      listSecrets: vi.fn(),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    };
    const toolAudit = { record: vi.fn() };
    const handlers = buildSettingsToolHandlers({
      orgs: {} as any,
      envs: envs as any,
      clusters: {} as any,
      toolAudit: toolAudit as any,
      prisma: {} as any,
    });
    const handler = handlers.find((candidate) => candidate.name === name)!;

    const result = await handler.execute(
      { name: "API_KEY", value: "sentinel-plaintext-secret" },
      scope,
      {} as any,
    );

    expect(result).toEqual(environmentUnavailable);
    expect(JSON.stringify(result)).not.toContain("sentinel");
    expect(envs.listSecrets).not.toHaveBeenCalled();
    expect(envs.setSecret).not.toHaveBeenCalled();
    expect(envs.deleteSecret).not.toHaveBeenCalled();
    expect(toolAudit.record).not.toHaveBeenCalled();
  });

  it("keeps EnvironmentService credential methods unavailable without querying Prisma", async () => {
    const service = new EnvironmentService({} as ControlDatabaseClient);

    await expect(service.listSecrets(scope, "user-a")).rejects.toThrow(
      "environment_credentials_unavailable",
    );
    await expect(
      service.setSecret(scope, "user-a", {
        name: "API_KEY",
        value: "sentinel-plaintext-secret",
      }),
    ).rejects.toThrow("environment_credentials_unavailable");
    await expect(
      service.deleteSecret(scope, "user-a", { name: "API_KEY" }),
    ).rejects.toThrow("environment_credentials_unavailable");
  });
});

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
