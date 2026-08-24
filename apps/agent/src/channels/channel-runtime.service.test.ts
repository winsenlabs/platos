import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import { ChannelRuntimeService } from "./channel-runtime.service";

function serviceHarness(overrides: {
  persistence?: Record<string, unknown>;
  dispatch?: Record<string, unknown>;
} = {}) {
  const persistence = {
    loadConnection: vi.fn(),
    loadInstallation: vi.fn(),
    resolveConnectionThread: vi.fn(),
    resolveAppThread: vi.fn(),
    stampInstallationLastEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides.persistence,
  };
  const dispatch = {
    collectTurn: vi.fn(),
    ...overrides.dispatch,
  };
  const service = new ChannelRuntimeService(
    {} as any,
    persistence as any,
    dispatch as any,
  );
  return { service, persistence, dispatch };
}

describe("ChannelRuntimeService canonical routing and credentials", () => {
  it("refuses an unavailable canonical connection before constructing an adapter", async () => {
    const { service, persistence } = serviceHarness({
      persistence: { loadConnection: vi.fn().mockResolvedValue(null) },
    });

    await expect(service.getOrCreateBot({ id: "connection-a" })).rejects.toThrow(
      "channel connection unavailable",
    );
    expect(persistence.loadConnection).toHaveBeenCalledWith("connection-a");
  });

  it("routes a connection thread while preserving qualified Slack identity and shared-thread semantics", async () => {
    const { service, persistence } = serviceHarness({
      persistence: {
        resolveConnectionThread: vi.fn().mockResolvedValue({
          agentId: "agent-routed",
          threadId: "thread-a",
          endUserId: "end-user-a",
        }),
      },
    });
    const authorScope: RequestScope = {
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "env-a",
      userId: "slack:T1:U1",
      userIdentities: [
        { channel: "slack", handle: "T1:U1", verified: true },
      ],
    };
    const conversationScope: RequestScope = {
      ...authorScope,
      userId: "channel:connection-a:slack:C1:123.4",
    };

    const result = await (
      service as unknown as {
        resolveThreadBinding: (
          connection: Record<string, unknown>,
          author: RequestScope,
          conversation: RequestScope,
          threadKey: string,
          text: string,
        ) => Promise<{
          agentId: string;
          platosThreadId: string;
          endUserId: string;
        }>;
      }
    ).resolveThreadBinding(
      {
        id: "connection-a",
        provider: "slack",
        organizationId: "org-a",
        projectId: "project-a",
        environmentId: "env-a",
        entityPk: null,
        agentId: "agent-default",
        agentRouting: [
          {
            match: { type: "prefix", value: "ada" },
            agentId: "agent-routed",
          },
        ],
        config: { team_id: "T1" },
      },
      authorScope,
      conversationScope,
      "slack:C1:123.4",
      "Ada: please help",
    );

    expect(persistence.resolveConnectionThread).toHaveBeenCalledWith({
      connection: expect.objectContaining({ id: "connection-a" }),
      provider: "slack",
      realm: "T1",
      authorSubject: "U1",
      channelThreadKey: "slack:C1:123.4",
      agentId: "agent-routed",
      singleEndUser: false,
    });
    expect(result).toEqual({
      agentId: "agent-routed",
      platosThreadId: "thread-a",
      endUserId: "end-user-a",
    });
  });

  it("fails closed for malformed decrypted connection credentials", () => {
    const { service } = serviceHarness();
    const decryptCredentials = (
      service as unknown as {
        decryptCredentials: (row: unknown) => Record<string, unknown>;
      }
    ).decryptCredentials.bind(service);

    expect(() =>
      decryptCredentials({
        id: "connection-a",
        credentials: { __platos_enc: 1, error: "decrypt_failed" },
      }),
    ).toThrow("channel credentials unavailable");
    expect(() =>
      decryptCredentials({ id: "connection-a", credentials: {} }),
    ).toThrow("channel credentials unavailable");
    expect(decryptCredentials({ id: "connection-a", credentials: null })).toEqual(
      {},
    );
  });

  it("fails an app event before thread resolution when the canonical bot credential is unavailable", async () => {
    const canonicalApp = {
      id: "app-a",
      provider: "slack",
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "env-a",
      defaultAgentId: "agent-a",
      agentRouting: [],
      linking: "none",
    };
    const canonicalInstallation = {
      id: "installation-a",
      status: "active",
      teamId: "T1",
      botToken: null,
      credentialRevision: "revision-a",
      app: canonicalApp,
    };
    const { service, persistence, dispatch } = serviceHarness({
      persistence: {
        loadInstallation: vi.fn().mockResolvedValue(canonicalInstallation),
      },
    });

    await expect(
      service.handleAppEvent(
        { id: "app-a", organizationId: "forged-org" },
        { id: "installation-a" },
        {
          event: {
            type: "app_mention",
            channel: "C1",
            user: "U1",
            text: "hello",
            ts: "123.4",
          },
        },
      ),
    ).rejects.toThrow("bot token unavailable");

    expect(persistence.loadInstallation).toHaveBeenCalledWith(
      "installation-a",
      "app-a",
    );
    expect(persistence.resolveAppThread).not.toHaveBeenCalled();
    expect(dispatch.collectTurn).not.toHaveBeenCalled();
  });

  it("uses canonical app ancestry, ordered routing, and qualified identity for an app turn", async () => {
    const canonicalApp = {
      id: "app-a",
      provider: "slack",
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "env-a",
      defaultAgentId: "agent-default",
      agentRouting: [
        {
          match: { type: "prefix", value: "ada" },
          agentId: "agent-routed",
        },
      ],
      linking: "none",
    };
    const canonicalInstallation = {
      id: "installation-a",
      status: "active",
      teamId: "T1",
      enterpriseId: null,
      botUserId: "BOT",
      botToken: "xoxb-test",
      credentialRevision: "revision-a",
      agentId: null,
      agentRouting: null,
      app: canonicalApp,
    };
    const loadInstallation = vi.fn().mockResolvedValue(canonicalInstallation);
    const resolveAppThread = vi.fn().mockResolvedValue({
      agentId: "agent-routed",
      threadId: "thread-a",
      endUserId: "end-user-a",
    });
    const collectTurn = vi.fn().mockResolvedValue({
      threadId: "thread-a",
      text: "",
    });
    const { service, persistence } = serviceHarness({
      persistence: { loadInstallation, resolveAppThread },
      dispatch: { collectTurn },
    });

    await service.handleAppEvent(
      {
        id: "app-a",
        organizationId: "forged-org",
        projectId: "forged-project",
        environmentId: "forged-env",
      },
      { id: "installation-a" },
      {
        team_id: "T1",
        event: {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          text: "Ada: investigate",
          ts: "123.4",
        },
      },
    );

    expect(resolveAppThread).toHaveBeenCalledWith({
      app: canonicalApp,
      installation: canonicalInstallation,
      realm: "T1",
      authorSubject: "U1",
      channelThreadKey: "slack:C1:123.4",
      agentId: "agent-routed",
      singleEndUser: false,
    });
    expect(collectTurn).toHaveBeenCalledWith("agent-routed", {
      scope: {
        organizationId: "org-a",
        projectId: "project-a",
        environmentId: "env-a",
        userId: "end-user-a",
        userIdentities: [
          { channel: "slack", handle: "T1:U1", verified: true },
        ],
        agentId: "agent-routed",
        threadId: "thread-a",
        sessionId: "thread-a",
      },
      message: "Ada: investigate",
      threadId: "thread-a",
    });
    expect(persistence.stampInstallationLastEvent).toHaveBeenCalledWith(
      "installation-a",
    );
  });
});

describe("ChannelRuntimeService build generation fencing", () => {
  const connection = {
    id: "connection-a",
    enabled: true,
    provider: "discord",
    credentialRevision: "revision-a",
  };

  it("stops and rejects a stale build invalidated before publication", async () => {
    let resolveBuild!: (value: any) => void;
    const gatewayStop = vi.fn();
    const close = vi.fn();
    const { service } = serviceHarness({
      persistence: { loadConnection: vi.fn().mockResolvedValue(connection) },
    });
    vi.spyOn(service as any, "buildBot").mockImplementationOnce(
      () => new Promise((resolve) => (resolveBuild = resolve)),
    );

    const pending = service.getOrCreateBot(connection);
    await Promise.resolve();
    service.invalidate(connection.id);
    resolveBuild({
      bot: { close },
      provider: "discord",
      credentialRevision: "revision-a",
      builtAt: Date.now(),
      gatewayStop,
    });

    await expect(pending).rejects.toThrow("build invalidated");
    expect(gatewayStop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect((service as any).cache.has(connection.id)).toBe(false);
  });

  it("deduplicates concurrent builds within one generation", async () => {
    const bot = {};
    const { service } = serviceHarness({
      persistence: { loadConnection: vi.fn().mockResolvedValue(connection) },
    });
    const build = vi.spyOn(service as any, "buildBot").mockResolvedValue({
      bot,
      provider: "discord",
      credentialRevision: "revision-a",
      builtAt: Date.now(),
    });

    const [a, b] = await Promise.all([
      service.getOrCreateBot(connection),
      service.getOrCreateBot(connection),
    ]);

    expect(build).toHaveBeenCalledOnce();
    expect(a.bot).toBe(bot);
    expect(b.bot).toBe(bot);
  });

  it("does not start a build after shutdown wins during canonical reload", async () => {
    let resolveLoad!: (value: any) => void;
    const { service } = serviceHarness({
      persistence: {
        loadConnection: vi.fn(() => new Promise((resolve) => (resolveLoad = resolve))),
      },
    });
    const build = vi.spyOn(service as any, "buildBot");
    const pending = service.getOrCreateBot(connection);
    service.onModuleDestroy();
    resolveLoad(connection);

    await expect(pending).rejects.toThrow("runtime destroyed");
    expect(build).not.toHaveBeenCalled();
  });

  it("does not publish a stale connection loaded across invalidation", async () => {
    let resolveLoad!: (value: any) => void;
    const { service } = serviceHarness({
      persistence: {
        loadConnection: vi.fn(() => new Promise((resolve) => (resolveLoad = resolve))),
      },
    });
    const build = vi.spyOn(service as any, "buildBot");
    const pending = service.getOrCreateBot(connection);
    service.invalidate(connection.id);
    resolveLoad(connection);

    await expect(pending).rejects.toThrow("build invalidated");
    expect(build).not.toHaveBeenCalled();
    expect((service as any).cache.has(connection.id)).toBe(false);
  });

  it("stops an asynchronous build that completes after shutdown", async () => {
    let resolveBuild!: (value: any) => void;
    const gatewayStop = vi.fn();
    const close = vi.fn();
    const { service } = serviceHarness({
      persistence: { loadConnection: vi.fn().mockResolvedValue(connection) },
    });
    vi.spyOn(service as any, "buildBot").mockImplementationOnce(
      () => new Promise((resolve) => (resolveBuild = resolve)),
    );
    const pending = service.getOrCreateBot(connection);
    await Promise.resolve();
    service.onModuleDestroy();
    resolveBuild({
      bot: { close },
      provider: "discord",
      credentialRevision: "revision-a",
      generation: 0,
      builtAt: Date.now(),
      gatewayStop,
    });

    await expect(pending).rejects.toThrow("build invalidated");
    expect(gatewayStop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect((service as any).cache.size).toBe(0);
  });
});

describe("ChannelRuntimeService durable Slack rotation", () => {
  const app = {
    id: "app-a",
    clientId: "client-a",
    clientSecret: "client-secret",
  };
  const installation = () => ({
    id: "installation-a",
    appId: "app-a",
    teamId: "T1",
    botToken: "old-bot",
    refreshToken: "old-refresh",
    tokenExpiresAt: new Date(Date.now() - 1_000),
    tokenRefreshState: "IDLE",
    credentialRevision: "revision-old",
    credentialId: "credential-a",
    tokenGeneration: 1,
  });

  it("does not publish or cache Slack's returned token when persistence fails", async () => {
    const preserve = vi.fn().mockResolvedValue(true);
    const { service } = serviceHarness({
      persistence: {
        beginInstallationRefresh: vi.fn().mockImplementation(async () => ({
          ...installation(),
          tokenRefreshState: "REFRESHING",
          app,
        })),
        finalizeInstallationRefresh: vi.fn().mockRejectedValue(new Error("db down")),
        preserveInstallationRefreshGrantForRepair: preserve,
        markInstallationRefreshRepairRequired: vi.fn(),
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({
        ok: true,
        access_token: "new-bot",
        refresh_token: "new-refresh",
        expires_in: 43_200,
      }),
    } as any);

    await expect(service.getFreshBotToken(installation(), app)).rejects.toThrow(
      "repair required",
    );

    expect(preserve).toHaveBeenCalledWith(
      "installation-a",
      "app-a",
      expect.any(String),
      {
        credentialId: "credential-a",
        credentialRevision: "revision-old",
        tokenGeneration: 1,
      },
      expect.objectContaining({ botToken: "new-bot", refreshToken: "new-refresh" }),
      "REFRESH_COMMIT_FAILED",
    );
    expect([...(service as any).appCache.values()]).not.toContainEqual(
      expect.objectContaining({ botToken: "new-bot" }),
    );
    fetchSpy.mockRestore();
  });

  it.each(["REPAIR_REQUIRED", "REFRESHING"])(
    "fails closed after restart when a prior refresh is %s",
    async (tokenRefreshState) => {
      const { service } = serviceHarness();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await expect(
        service.getFreshBotToken(
          { ...installation(), tokenRefreshState },
          app,
        ),
      ).rejects.toThrow(/repair required|refresh incomplete/);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    },
  );

  it("serializes concurrent refreshes and lets the loser adopt only the committed row", async () => {
    let claimed = false;
    let durableRow: any = null;
    const beginInstallationRefresh = vi.fn().mockImplementation(async () => {
      if (claimed) return null;
      claimed = true;
      return { ...installation(), tokenRefreshState: "REFRESHING", app };
    });
    const { service } = serviceHarness({
      persistence: {
        beginInstallationRefresh,
        finalizeInstallationRefresh: vi.fn().mockImplementation(async () => {
          durableRow = {
            ...installation(),
            botToken: "new-bot",
            refreshToken: "new-refresh",
            tokenExpiresAt: new Date(Date.now() + 43_200_000),
            tokenRefreshState: "IDLE",
            credentialRevision: "revision-new",
            tokenGeneration: 2,
          };
          return durableRow;
        }),
        loadInstallation: vi.fn().mockImplementation(async () => durableRow),
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({
        ok: true,
        access_token: "new-bot",
        refresh_token: "new-refresh",
        expires_in: 43_200,
      }),
    } as any);

    const [winner, loser] = await Promise.all([
      service.getFreshBotToken(installation(), app),
      service.getFreshBotToken(installation(), app),
    ]);

    expect(winner).toBe("new-bot");
    expect(loser).toBe("new-bot");
    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it("drops a stale refresh result after reinstall advances the token generation", async () => {
    const replacement = {
      ...installation(),
      botToken: "reinstalled-bot",
      refreshToken: "reinstalled-refresh",
      tokenExpiresAt: new Date(Date.now() + 43_200_000),
      tokenGeneration: 2,
      credentialRevision: "revision-reinstalled",
    };
    const preserve = vi.fn();
    const markRepair = vi.fn();
    const { service } = serviceHarness({
      persistence: {
        beginInstallationRefresh: vi.fn().mockResolvedValue({
          ...installation(),
          tokenRefreshState: "REFRESHING",
          app,
        }),
        finalizeInstallationRefresh: vi.fn().mockResolvedValue(null),
        loadInstallation: vi.fn().mockResolvedValue(replacement),
        preserveInstallationRefreshGrantForRepair: preserve,
        markInstallationRefreshRepairRequired: markRepair,
      },
    });
    vi.spyOn(service as any, "sleep").mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({
        ok: true,
        access_token: "stale-worker-bot",
        refresh_token: "stale-worker-refresh",
        expires_in: 43_200,
      }),
    } as any);

    await expect(service.getFreshBotToken(installation(), app)).resolves.toBe("reinstalled-bot");
    expect(preserve).not.toHaveBeenCalled();
    expect(markRepair).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("ChannelRuntimeService durable event effects", () => {
  it("reuses a persisted turn and sends the same Slack dedupe id after recovery", async () => {
    const canonicalApp = {
      id: "app-a",
      provider: "slack",
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "env-a",
      defaultAgentId: "agent-a",
      agentRouting: [],
      linking: "none",
    };
    const canonicalInstallation = {
      id: "installation-a",
      status: "active",
      teamId: "T1",
      botToken: "xoxb-test",
      credentialRevision: "revision-a",
      agentId: null,
      agentRouting: null,
      app: canonicalApp,
    };
    const collectTurn = vi.fn().mockResolvedValue({
      threadId: "thread-a",
      text: "durable reply",
      messageId: "turn-a",
    });
    const { service } = serviceHarness({
      persistence: {
        loadInstallation: vi.fn().mockResolvedValue(canonicalInstallation),
        resolveAppThread: vi.fn().mockResolvedValue({
          agentId: "agent-a",
          threadId: "thread-a",
          endUserId: "end-user-a",
        }),
      },
      dispatch: { collectTurn },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ts: "1.2" }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: "duplicate_message" }),
      } as any);
    const envelope = {
      team_id: "T1",
      event: { type: "app_mention", channel: "C1", user: "U1", text: "hello", ts: "1.1" },
    };
    const firstTurn = vi.fn().mockResolvedValue(true);
    const firstDelivery = vi.fn().mockResolvedValue(true);
    await service.handleAppEvent(canonicalApp, canonicalInstallation, envelope, {
      eventId: "Ev1",
      abortSignal: new AbortController().signal,
      persistedTurn: null,
      onTurnCompleted: firstTurn,
      onDeliveryCompleted: firstDelivery,
    });
    const secondTurn = vi.fn().mockResolvedValue(true);
    await service.handleAppEvent(canonicalApp, canonicalInstallation, envelope, {
      eventId: "Ev1",
      abortSignal: new AbortController().signal,
      persistedTurn: { id: "turn-a", threadId: "thread-a", outputText: "durable reply" },
      onTurnCompleted: secondTurn,
      onDeliveryCompleted: vi.fn().mockResolvedValue(true),
    });

    expect(collectTurn).toHaveBeenCalledOnce();
    expect(collectTurn).toHaveBeenCalledWith(
      "agent-a",
      expect.objectContaining({ idempotencyKey: "channel-event:app-a:Ev1" }),
    );
    expect(firstTurn).toHaveBeenCalledWith("turn-a");
    expect(secondTurn).not.toHaveBeenCalled();
    const bodies = fetchSpy.mock.calls.map((call) => JSON.parse(String((call[1] as any).body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].client_msg_id).toBe(bodies[1].client_msg_id);
    fetchSpy.mockRestore();
  });

  it.each([
    [new Error("network"), true],
    [{ ok: false, status: 500, json: async () => ({ error: "server_error" }) }, true],
    [{ ok: true, status: 200, json: async () => ({ ok: false, error: "invalid_auth" }) }, false],
  ])("classifies Slack delivery failures", async (failure, retryable) => {
    const { service } = serviceHarness();
    const fetchSpy =
      failure instanceof Error
        ? vi.spyOn(globalThis, "fetch").mockRejectedValue(failure)
        : vi.spyOn(globalThis, "fetch").mockResolvedValue(failure as any);
    await expect(
      (service as any).postSlackMessage("token", "C1", undefined, "reply"),
    ).rejects.toMatchObject({ retryable });
    fetchSpy.mockRestore();
  });
});
