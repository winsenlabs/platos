/**
 * Connect v3 (operator install tier) — install IMPORT API + operator status
 * surface, ADDITIVE to the hosted-OAuth flow.
 *
 * Acceptance pinned here:
 *  - Two installs under ONE app — one persisted the way the OAuth callback
 *    would, one created via the new import API with an operator bot token —
 *    are DISTINCT rows and therefore route to DISTINCT Platos threads + DISTINCT
 *    end users (the runtime keys a thread by installationId and an end user by
 *    `<team>:<slackUser>`; both differ, so even an identical inbound message
 *    cannot collide).
 *  - Import is IDEMPOTENT on the nullable (appId, teamId, enterpriseId) tuple
 *    (re-import updates in place, un-revokes) and encrypts the bot token with
 *    the SAME MessageCryptoService envelope the callback uses — never plaintext.
 *  - Import is scope-guarded (cross-scope appId → 404) and honours the same
 *    in-scope agent guard as bind at import time.
 *  - Uninstall (soft-revoke) is OPERATOR-VISIBLE via the status surface as
 *    `status: "revoked"`.
 *
 * CLAUDE.md §9.11: Vitest, no mocking framework — an in-memory Prisma shim +
 * a round-tripping MessageCrypto fake. Mirrors channel-app-events.controller.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ChannelAppsController } from "./channel-apps.controller";

// ── In-memory Prisma shim ──────────────────────────────────────────────────
type AppRow = {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  provider: string;
  defaultAgentId: string | null;
  agentRouting: unknown | null;
};
type InstallRow = {
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
  agentRouting: unknown | null;
  status: string;
  revokedAt: Date | null;
  lastEventAt: Date | null;
  createdAt: Date;
};
type AgentRow = {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
};

// Prisma treats every provided where key as an equality filter; `null` compiles
// to `IS NULL` — replicated by strict `===` (row nulls are literal null).
const matches = (row: any, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([k, v]) => row[k] === v);

function makePrisma(seed: { apps?: AppRow[]; installs?: InstallRow[]; agents?: AgentRow[] } = {}) {
  const apps = seed.apps ?? [];
  const installs = seed.installs ?? [];
  const agents = seed.agents ?? [];
  let seq = 0;
  const nextId = (p: string) => `${p}_${++seq}`;
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
      findMany: async ({ where }: any) =>
        installs
          .filter((r) => matches(r, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      create: async ({ data }: any) => {
        const row: InstallRow = {
          id: nextId("inst"),
          appId: data.appId,
          teamId: data.teamId ?? null,
          enterpriseId: data.enterpriseId ?? null,
          isEnterpriseInstall: data.isEnterpriseInstall ?? false,
          teamName: data.teamName ?? null,
          botToken: data.botToken,
          refreshToken: data.refreshToken ?? null,
          tokenExpiresAt: data.tokenExpiresAt ?? null,
          botUserId: data.botUserId ?? null,
          grantedScopes: data.grantedScopes ?? [],
          installedByUserId: data.installedByUserId ?? null,
          agentId: data.agentId ?? null,
          agentRouting: data.agentRouting ?? null,
          status: data.status ?? "active",
          revokedAt: data.revokedAt ?? null,
          lastEventAt: data.lastEventAt ?? null,
          createdAt: new Date(Date.now() + seq), // stable ordering
        };
        installs.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = installs.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
    },
  };
}

// Round-tripping crypto fake — envelope on encrypt, unwrap on decrypt.
const messageCrypto = {
  encryptJsonField: (v: unknown) => ({ __enc: true, v }),
  decryptJsonField: (e: any) => e?.v,
} as any;

// invalidateApp resolves ChannelRuntimeService via ModuleRef; absent in a
// focused module — the controller swallows the throw.
const moduleRef = {
  get: () => {
    throw new Error("no runtime in test module");
  },
} as any;

const SCOPE = {
  organizationId: "org1",
  projectId: "proj1",
  environmentId: "env1",
  userId: "u1",
  principal: "operator" as const,
};
const OTHER_SCOPE = { ...SCOPE, organizationId: "orgX" };

const req = (scope: unknown) => ({ scope }) as any;

function makeApp(over: Partial<AppRow> = {}): AppRow {
  return {
    id: "app1",
    organizationId: "org1",
    projectId: "proj1",
    environmentId: "env1",
    provider: "slack",
    defaultAgentId: null,
    agentRouting: null,
    ...over,
  };
}

describe("ChannelAppsController — operator install import", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let ctrl: any;

  beforeEach(() => {
    prisma = makePrisma({ apps: [makeApp()] });
    ctrl = new ChannelAppsController(prisma as any, messageCrypto, moduleRef);
  });

  it("imports an install under an in-scope app, encrypting the bot token (never plaintext)", async () => {
    const res = await ctrl.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      teamName: "Acme",
      botToken: "xoxb-secret-token",
    });
    expect(res.installation.status).toBe("active");
    expect(res.installation.teamId).toBe("T100");
    // Redacted projection: bot token stripped, boolean surfaced.
    expect(res.installation.botToken).toBeUndefined();
    expect(res.installation.hasBotToken).toBe(true);
    // Stored value is the crypto envelope, and it round-trips — NOT plaintext.
    const stored = prisma.installs[0].botToken;
    expect(stored).not.toBe("xoxb-secret-token");
    expect(messageCrypto.decryptJsonField(JSON.parse(stored))).toBe("xoxb-secret-token");
  });

  it("is idempotent on (appId, teamId, enterpriseId) and un-revokes on re-import", async () => {
    const first = await ctrl.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      botToken: "xoxb-1",
    });
    // Soft-revoke it, then re-import the same workspace. Also simulate stale
    // ROTATION state left behind by a previous rotating OAuth install — a
    // re-import with a static operator token must clear it, or the runtime's
    // getFreshBotToken would treat the imported token as rotating and could
    // refresh the OLD grant over the freshly imported key.
    await ctrl.revokeInstallation(req(SCOPE), "app1", first.installation.id);
    expect(prisma.installs[0].status).toBe("revoked");
    prisma.installs[0].refreshToken = JSON.stringify(
      messageCrypto.encryptJsonField("xoxe-old-refresh"),
    );
    prisma.installs[0].tokenExpiresAt = new Date(Date.now() - 1000);
    const second = await ctrl.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      botToken: "xoxb-2",
    });
    // SAME row — no duplicate insert despite the nullable enterpriseId.
    expect(prisma.installs.length).toBe(1);
    expect(second.installation.id).toBe(first.installation.id);
    expect(prisma.installs[0].status).toBe("active");
    expect(prisma.installs[0].revokedAt).toBeNull();
    // Re-keyed to the new token, and the stale rotation state is cleared so the
    // imported static token is authoritative (non-rotating short-circuit).
    expect(messageCrypto.decryptJsonField(JSON.parse(prisma.installs[0].botToken))).toBe("xoxb-2");
    expect(prisma.installs[0].refreshToken).toBeNull();
    expect(prisma.installs[0].tokenExpiresAt).toBeNull();
  });

  it("rejects a cross-scope appId (404) without writing", async () => {
    await expect(
      ctrl.importInstallation(req(OTHER_SCOPE), "app1", { teamId: "T100", botToken: "xoxb" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.installs.length).toBe(0);
  });

  it("requires a bot token and a workspace anchor", async () => {
    await expect(
      ctrl.importInstallation(req(SCOPE), "app1", { teamId: "T100" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      ctrl.importInstallation(req(SCOPE), "app1", { botToken: "xoxb" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.installs.length).toBe(0);
  });

  it("binds an in-scope agent at import time and rejects a forged agentId", async () => {
    prisma.agents.push({
      id: "agentA",
      organizationId: "org1",
      projectId: "proj1",
      environmentId: "env1",
    });
    const ok = await ctrl.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      botToken: "xoxb",
      agentId: "agentA",
    });
    expect(ok.installation.agentId).toBe("agentA");

    await expect(
      ctrl.importInstallation(req(SCOPE), "app1", {
        teamId: "T200",
        botToken: "xoxb",
        agentId: "ghost",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an end-user (non-operator) principal", async () => {
    await expect(
      ctrl.importInstallation(req({ ...SCOPE, principal: "end-user" }), "app1", {
        teamId: "T100",
        botToken: "xoxb",
      }),
    ).rejects.toBeTruthy();
    expect(prisma.installs.length).toBe(0);
  });
});

describe("ChannelAppsController — two installs route to distinct threads + end users", () => {
  // Replicates the runtime's key derivation (channel-runtime.service.ts):
  //   thread    → keyed by (installationId, channelThreadKey)   [line 1407]
  //   conv user → `channel-app:${installationId}:${channelThreadKey}` [appConversationUserId]
  //   end user  → verified claim handle `${team}:${slackUser}`  [handleAppEvent ~998]
  const channelThreadKey = (channel: string, ts: string) => `slack:${channel}:${ts}`;
  const convUserId = (installationId: string, ctk: string) =>
    `channel-app:${installationId}:${ctk}`;
  const endUserHandle = (team: string, slackUser: string) => `${team}:${slackUser}`;

  it("distinct installationId ⇒ distinct thread + distinct conversation identity; distinct team ⇒ distinct end user", async () => {
    const prisma = makePrisma({ apps: [makeApp()] });
    const ctrl: any = new ChannelAppsController(prisma as any, messageCrypto, moduleRef);

    // Install A — persisted exactly as the OAuth callback's upsertInstallation would.
    const oauthRow = await prisma.platosChannelInstallation.create({
      data: {
        appId: "app1",
        teamId: "T_OAUTH",
        botToken: JSON.stringify(messageCrypto.encryptJsonField("xoxb-oauth")),
        status: "active",
      },
    });
    // Install B — via the new operator import API, different workspace + token.
    const importRes = await ctrl.importInstallation(req(SCOPE), "app1", {
      teamId: "T_IMPORT",
      botToken: "xoxb-import",
    });
    const importRow = importRes.installation;

    // Two DISTINCT rows under the one app.
    expect(prisma.installs.length).toBe(2);
    expect(oauthRow.id).not.toBe(importRow.id);
    expect(oauthRow.teamId).not.toBe(importRow.teamId);

    // Even an IDENTICAL inbound (same channel, thread ts, slack user) cannot collide:
    const ctk = channelThreadKey("C1", "1700000000.1");
    const slackUser = "U9";
    // Distinct thread binding (keyed by installationId).
    expect(convUserId(oauthRow.id, ctk)).not.toBe(convUserId(importRow.id, ctk));
    // Distinct end user (handle qualified by team).
    expect(endUserHandle(oauthRow.teamId!, slackUser)).not.toBe(
      endUserHandle(importRow.teamId!, slackUser),
    );
  });
});

describe("ChannelAppsController — operator-visible install lifecycle", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let ctrl: any;

  beforeEach(() => {
    prisma = makePrisma({ apps: [makeApp({ defaultAgentId: "appDefaultAgent" })] });
    ctrl = new ChannelAppsController(prisma as any, messageCrypto, moduleRef);
  });

  it("status surface reports lifecycle + resolved agent binding, and reflects a soft-revoke", async () => {
    const imported = await ctrl.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      teamName: "Acme",
      botToken: "xoxb",
    });

    let status = await ctrl.installationsStatus(req(SCOPE), "app1");
    expect(status.installations).toHaveLength(1);
    const view = status.installations[0];
    expect(view).toMatchObject({
      teamId: "T100",
      teamName: "Acme",
      status: "active",
      lastEventAt: null,
    });
    // No per-install override → inherits the app default.
    expect(view.agentBinding).toMatchObject({
      agentId: null,
      effectiveAgentId: "appDefaultAgent",
      source: "app",
      hasRoutingOverride: false,
    });
    // The compact status view NEVER leaks the bot token.
    expect(view.botToken).toBeUndefined();

    // Uninstall (soft-revoke) is operator-visible as status=revoked.
    await ctrl.revokeInstallation(req(SCOPE), "app1", imported.installation.id);
    status = await ctrl.installationsStatus(req(SCOPE), "app1");
    expect(status.installations[0].status).toBe("revoked");
    expect(status.installations[0].revokedAt).toBeInstanceOf(Date);
  });

  it("status surface is scope-guarded (cross-scope appId → 404)", async () => {
    await expect(ctrl.installationsStatus(req(OTHER_SCOPE), "app1")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("reports an installation override as agentBinding.source=installation", async () => {
    prisma.agents.push({
      id: "overrideAgent",
      organizationId: "org1",
      projectId: "proj1",
      environmentId: "env1",
    });
    await ctrl.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      botToken: "xoxb",
      agentId: "overrideAgent",
    });
    const status = await ctrl.installationsStatus(req(SCOPE), "app1");
    expect(status.installations[0].agentBinding).toMatchObject({
      agentId: "overrideAgent",
      effectiveAgentId: "overrideAgent",
      source: "installation",
    });
  });
});
