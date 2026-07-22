/**
 * Connect v3 (operator install tier) — channel_apps.* install-import MCP tools.
 *
 * The tool surface (import_installation / revoke_installation /
 * installations_status) mirrors the REST controller byte-for-byte per the file's
 * own contract; these focused tests pin the tool-specific wiring: scope is taken
 * from the verified token (never args), the bot token is encrypted with the same
 * envelope, import is idempotent + scope-guarded, and the status tool reflects a
 * soft-revoke. Mirrors the REST test's harness.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { buildChannelAppToolHandlers } from "./channel-apps";
import type { McpToolHandler } from "../mcp-router";

const matches = (row: any, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([k, v]) => row[k] === v);

function makePrisma(apps: any[]) {
  const installs: any[] = [];
  const agents: any[] = [];
  let seq = 0;
  return {
    apps,
    installs,
    agents,
    platosChannelApp: {
      findFirst: async ({ where }: any) => apps.find((a) => matches(a, where)) ?? null,
    },
    platosAgent: {
      findFirst: async ({ where }: any) => agents.find((a) => matches(a, where)) ?? null,
    },
    platosChannelInstallation: {
      findFirst: async ({ where }: any) => installs.find((r) => matches(r, where)) ?? null,
      findMany: async ({ where }: any) => installs.filter((r) => matches(r, where)),
      create: async ({ data }: any) => {
        const row = {
          id: `inst_${++seq}`,
          teamId: null,
          enterpriseId: null,
          isEnterpriseInstall: false,
          teamName: null,
          botUserId: null,
          grantedScopes: [],
          installedByUserId: null,
          agentId: null,
          agentRouting: null,
          status: "active",
          revokedAt: null,
          lastEventAt: null,
          ...data,
        };
        installs.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = installs.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
  };
}

const messageCrypto = {
  encryptJsonField: (v: unknown) => ({ __enc: true, v }),
  decryptJsonField: (e: any) => e?.v,
} as any;
const toolAudit = { record: async () => undefined } as any;

const SCOPE = {
  organizationId: "org1",
  projectId: "proj1",
  environmentId: "env1",
  userId: "u1",
  principal: "operator" as const,
};
const TOKEN = {} as any;

function tools(prisma: any): Record<string, McpToolHandler> {
  const handlers = buildChannelAppToolHandlers({ prisma, messageCrypto, toolAudit });
  return Object.fromEntries(handlers.map((h) => [h.name, h]));
}

const app = () => ({
  id: "app1",
  organizationId: "org1",
  projectId: "proj1",
  environmentId: "env1",
  provider: "slack",
  defaultAgentId: null,
});

describe("channel_apps.import_installation (MCP)", () => {
  let prisma: any;
  let t: Record<string, McpToolHandler>;

  beforeEach(() => {
    prisma = makePrisma([app()]);
    t = tools(prisma);
  });

  it("exposes the three new tools", () => {
    expect(t["channel_apps.import_installation"]).toBeTruthy();
    expect(t["channel_apps.revoke_installation"]).toBeTruthy();
    expect(t["channel_apps.installations_status"]).toBeTruthy();
  });

  it("imports + encrypts the bot token, scope taken from the token", async () => {
    const res: any = await t["channel_apps.import_installation"].execute(
      { appId: "app1", teamId: "T1", botToken: "xoxb-secret" },
      SCOPE,
      TOKEN,
    );
    expect(res.hasBotToken).toBe(true);
    expect(res.botToken).toBeUndefined();
    expect(messageCrypto.decryptJsonField(JSON.parse(prisma.installs[0].botToken))).toBe(
      "xoxb-secret",
    );
  });

  it("is idempotent on (appId, teamId, enterpriseId) and clears stale rotation state", async () => {
    await t["channel_apps.import_installation"].execute(
      { appId: "app1", teamId: "T1", botToken: "xoxb-1" },
      SCOPE,
      TOKEN,
    );
    // Simulate rotation state left behind by a previous rotating OAuth install;
    // a static-token re-import must clear it (getFreshBotToken keys the
    // rotation decision off tokenExpiresAt).
    prisma.installs[0].refreshToken = "old-refresh-envelope";
    prisma.installs[0].tokenExpiresAt = new Date(Date.now() - 1000);
    await t["channel_apps.import_installation"].execute(
      { appId: "app1", teamId: "T1", botToken: "xoxb-2" },
      SCOPE,
      TOKEN,
    );
    expect(prisma.installs.length).toBe(1);
    expect(messageCrypto.decryptJsonField(JSON.parse(prisma.installs[0].botToken))).toBe("xoxb-2");
    expect(prisma.installs[0].refreshToken).toBeNull();
    expect(prisma.installs[0].tokenExpiresAt).toBeNull();
  });

  it("rejects a cross-scope appId", async () => {
    const res: any = await t["channel_apps.import_installation"].execute(
      { appId: "app1", teamId: "T1", botToken: "xoxb" },
      { ...SCOPE, organizationId: "orgX" },
      TOKEN,
    );
    expect(res.error).toBe("not_found");
    expect(prisma.installs.length).toBe(0);
  });

  it("status tool reflects a soft-revoke and never leaks the token", async () => {
    const imp: any = await t["channel_apps.import_installation"].execute(
      { appId: "app1", teamId: "T1", teamName: "Acme", botToken: "xoxb" },
      SCOPE,
      TOKEN,
    );
    let status: any = await t["channel_apps.installations_status"].execute(
      { appId: "app1" },
      SCOPE,
      TOKEN,
    );
    expect(status.installations[0]).toMatchObject({ teamId: "T1", status: "active" });
    expect(status.installations[0].botToken).toBeUndefined();

    await t["channel_apps.revoke_installation"].execute(
      { appId: "app1", installationId: imp.id },
      SCOPE,
      TOKEN,
    );
    status = await t["channel_apps.installations_status"].execute({ appId: "app1" }, SCOPE, TOKEN);
    expect(status.installations[0].status).toBe("revoked");
  });
});
