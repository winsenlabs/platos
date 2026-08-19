import { beforeEach, describe, expect, it } from "vitest";
import type { McpToolHandler } from "../mcp-router";
import { buildChannelAppToolHandlers } from "./channel-apps";

const toolAudit = { record: async () => undefined } as any;

const SCOPE = {
  organizationId: "org1",
  projectId: "proj1",
  environmentId: "env1",
  userId: "u1",
  principal: "operator" as const,
};
const TOKEN = {} as any;

type Installation = {
  id: string;
  appId: string;
  teamId: string | null;
  enterpriseId: string | null;
  isEnterpriseInstall: boolean;
  teamName: string | null;
  botToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  botUserId: string | null;
  grantedScopes: string[];
  installedByUserId: string | null;
  agentId: string | null;
  agentRouting: unknown;
  status: string;
  revokedAt: Date | null;
  lastEventAt: Date | null;
};

function app() {
  return {
    id: "app1",
    organizationId: "org1",
    projectId: "proj1",
    environmentId: "env1",
    provider: "slack",
    defaultAgentId: null,
  };
}

function harness() {
  const apps = [app()];
  const installs: Installation[] = [];
  let sequence = 0;
  const loadScopedApp = async (scope: typeof SCOPE, appId: string) =>
    apps.find(
      (candidate) =>
        candidate.id === appId &&
        candidate.organizationId === scope.organizationId &&
        candidate.projectId === scope.projectId &&
        candidate.environmentId === scope.environmentId,
    ) ?? null;
  const loadApp = async (appId: string) => apps.find((candidate) => candidate.id === appId) ?? null;
  const loadInstallation = async (installationId: string, appId?: string) =>
    installs.find(
      (installation) =>
        installation.id === installationId && (!appId || installation.appId === appId),
    ) ?? null;

  const channelPersistence = {
    loadScopedApp,
    loadApp,
    loadInstallation,
    listInstallations: async (scope: typeof SCOPE, appId: string) =>
      (await loadScopedApp(scope, appId))
        ? installs.filter((installation) => installation.appId === appId)
        : null,
    upsertInstallationGrant: async (
      appRow: ReturnType<typeof app>,
      coordinates: {
        teamId: string | null;
        enterpriseId: string | null;
        isEnterpriseInstall: boolean;
      },
      grant: {
        botToken: string;
        refreshToken?: string | null;
        tokenExpiresAt?: Date | null;
        botUserId?: string | null;
        grantedScopes: string[];
        displayName?: string | null;
        installedByUserId?: string | null;
        defaultAgentId?: string | null;
        agentRouting?: unknown;
      },
    ) => {
      let installation = installs.find(
        (candidate) =>
          candidate.appId === appRow.id &&
          candidate.teamId === coordinates.teamId &&
          candidate.enterpriseId === coordinates.enterpriseId,
      );
      if (!installation) {
        installation = {
          id: `inst_${++sequence}`,
          appId: appRow.id,
          teamId: coordinates.teamId,
          enterpriseId: coordinates.enterpriseId,
          isEnterpriseInstall: coordinates.isEnterpriseInstall,
          teamName: grant.displayName ?? null,
          botToken: grant.botToken,
          refreshToken: grant.refreshToken ?? null,
          tokenExpiresAt: grant.tokenExpiresAt ?? null,
          botUserId: grant.botUserId ?? null,
          grantedScopes: grant.grantedScopes,
          installedByUserId: grant.installedByUserId ?? null,
          agentId: grant.defaultAgentId ?? null,
          agentRouting: grant.agentRouting ?? null,
          status: "active",
          revokedAt: null,
          lastEventAt: null,
        };
        installs.push(installation);
      } else {
        Object.assign(installation, {
          isEnterpriseInstall: coordinates.isEnterpriseInstall,
          teamName: grant.displayName ?? null,
          botToken: grant.botToken,
          refreshToken: grant.refreshToken ?? null,
          tokenExpiresAt: grant.tokenExpiresAt ?? null,
          botUserId: grant.botUserId ?? null,
          grantedScopes: grant.grantedScopes,
          installedByUserId: grant.installedByUserId ?? null,
          status: "active",
          revokedAt: null,
          ...(grant.defaultAgentId !== undefined ? { agentId: grant.defaultAgentId } : {}),
          ...(grant.agentRouting !== undefined ? { agentRouting: grant.agentRouting } : {}),
        });
      }
      return installation;
    },
    revokeInstallation: async (scope: typeof SCOPE, appId: string, installationId: string) => {
      if (!(await loadScopedApp(scope, appId))) return null;
      const installation = await loadInstallation(installationId, appId);
      if (!installation) return null;
      installation.status = "revoked";
      installation.revokedAt = new Date();
      return installation;
    },
  };
  const prisma = { agentBinding: { findFirst: async () => null } } as any;
  const handlers = buildChannelAppToolHandlers({
    prisma,
    channelPersistence: channelPersistence as any,
    toolAudit,
  });
  return {
    installs,
    tools: Object.fromEntries(handlers.map((handler) => [handler.name, handler])) as Record<
      string,
      McpToolHandler
    >,
  };
}

describe("channel_apps.import_installation (MCP)", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it("exposes the three installation tools", () => {
    expect(h.tools["channel_apps.import_installation"]).toBeTruthy();
    expect(h.tools["channel_apps.revoke_installation"]).toBeTruthy();
    expect(h.tools["channel_apps.installations_status"]).toBeTruthy();
  });

  it("imports the bot token through the canonical persistence boundary", async () => {
    const result: any = await h.tools["channel_apps.import_installation"].execute(
      { appId: "app1", teamId: "T1", botToken: "xoxb-secret" },
      SCOPE,
      TOKEN,
    );
    expect(result.hasBotToken).toBe(true);
    expect(result.botToken).toBeUndefined();
    expect(h.installs[0].botToken).toBe("xoxb-secret");
  });

  it("is idempotent and clears stale rotating-grant state", async () => {
    await h.tools["channel_apps.import_installation"].execute(
      { appId: "app1", teamId: "T1", botToken: "xoxb-1" },
      SCOPE,
      TOKEN,
    );
    h.installs[0].refreshToken = "old-refresh";
    h.installs[0].tokenExpiresAt = new Date(Date.now() - 1000);
    await h.tools["channel_apps.import_installation"].execute(
      { appId: "app1", teamId: "T1", botToken: "xoxb-2" },
      SCOPE,
      TOKEN,
    );
    expect(h.installs).toHaveLength(1);
    expect(h.installs[0]).toMatchObject({
      botToken: "xoxb-2",
      refreshToken: null,
      tokenExpiresAt: null,
    });
  });

  it("rejects a cross-scope appId", async () => {
    const result: any = await h.tools["channel_apps.import_installation"].execute(
      { appId: "app1", teamId: "T1", botToken: "xoxb" },
      { ...SCOPE, organizationId: "orgX" },
      TOKEN,
    );
    expect(result.error).toBe("not_found");
    expect(h.installs).toHaveLength(0);
  });

  it("reflects a soft revoke without leaking the token", async () => {
    const imported: any = await h.tools["channel_apps.import_installation"].execute(
      { appId: "app1", teamId: "T1", teamName: "Acme", botToken: "xoxb" },
      SCOPE,
      TOKEN,
    );
    await h.tools["channel_apps.revoke_installation"].execute(
      { appId: "app1", installationId: imported.id },
      SCOPE,
      TOKEN,
    );
    const status: any = await h.tools["channel_apps.installations_status"].execute(
      { appId: "app1" },
      SCOPE,
      TOKEN,
    );
    expect(status.installations[0]).toMatchObject({ teamId: "T1", status: "revoked" });
    expect(status.installations[0].botToken).toBeUndefined();
  });
});
