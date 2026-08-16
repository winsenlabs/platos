import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import { ChannelRuntimeService } from "./channel-runtime.service";

function serviceHarness(overrides: {
  persistence?: Record<string, unknown>;
  dispatch?: Record<string, unknown>;
  redis?: Record<string, unknown>;
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
  const redis = {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    ...overrides.redis,
  };
  const service = new ChannelRuntimeService(
    {} as any,
    redis as any,
    persistence as any,
    dispatch as any,
  );
  return { service, persistence, dispatch, redis };
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

  it("drops an app event before thread resolution when the canonical bot credential is unavailable", async () => {
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

    await service.handleAppEvent(
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
    );

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
