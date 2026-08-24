import { createHash } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { mintSessionToken } from "@platosdev/token-mint";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service";
import { ScopeGuard } from "../auth/scope.guard";
import { SessionTokenController } from "../auth/session-token.controller";
import { ConnectionsGateway } from "./connections.gateway";

const RAW_BEARER = `plt_ent_${"b".repeat(64)}`;
const SCOPE = {
  organizationId: "org-ws",
  projectId: "project-ws",
  environmentId: "environment-ws",
  userId: "user-ws",
  entityId: "entity-ws",
};

function makeHarness() {
  const state = {
    bearer: {
      id: "bearer-ws",
      tokenHash: createHash("sha256").update(RAW_BEARER).digest("hex"),
      environmentId: SCOPE.environmentId,
      revokedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 120_000) as Date | null,
      entity: {
        externalId: SCOPE.entityId,
        project: { id: SCOPE.projectId, organizationId: SCOPE.organizationId },
      },
    },
    environment: {
      id: SCOPE.environmentId,
      project: { id: SCOPE.projectId, organizationId: SCOPE.organizationId },
    },
  };
  const prisma = {
    mcpBearerToken: {
      findUnique: vi.fn(async (args: any) => {
        if (args.where.tokenHash && args.where.tokenHash !== state.bearer.tokenHash) return null;
        if (args.where.id && args.where.id !== state.bearer.id) return null;
        return state.bearer;
      }),
      updateMany: vi.fn(async () => ({
        count:
          !state.bearer.revokedAt &&
          (!state.bearer.expiresAt || state.bearer.expiresAt.getTime() > Date.now())
            ? 1
            : 0,
      })),
    },
    environment: {
      findUnique: vi.fn(async (args: any) =>
        args.where.id === state.environment.id ? state.environment : null,
      ),
    },
    accessKey: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const auth = new AuthService(prisma as any, {} as any);
  const conversationService = {
    getThread: vi.fn(async (_threadId: string, _scope: unknown, options: { allUsers: boolean }) =>
      options.allUsers ? { id: _threadId, userId: "other-user" } : null,
    ),
  };
  const agentTaskService = { conversationService };
  const gateway = new ConnectionsGateway(
    agentTaskService as any,
    {} as any,
    auth,
    {} as any,
    prisma as any,
  );
  return {
    state,
    auth,
    gateway,
    conversationService,
    controller: new SessionTokenController(auth, prisma as any),
  };
}

function clientFor(token: string) {
  return {
    id: "socket-ws",
    handshake: {
      auth: { token },
      headers: { "x-forwarded-for": "203.0.113.4" },
    },
    nsp: { name: "/agent/entity-ws" },
    emit: vi.fn(),
    disconnect: vi.fn(),
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
  } as any;
}

function httpContext(token: string) {
  const request: any = {
    headers: { "x-platos-session-token": token },
    url: "/api/v1/agent/threads",
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ status: () => ({ json: () => undefined }) }),
    }),
  } as any;
}

async function mint(controller: SessionTokenController) {
  return controller.mint(SCOPE.entityId, `Bearer ${RAW_BEARER}`, {
    organizationId: SCOPE.organizationId,
    projectId: SCOPE.projectId,
    environmentId: SCOPE.environmentId,
    userId: SCOPE.userId,
    ttlSeconds: 60,
  });
}

describe("bearer-backed HTTP and WebSocket session lifecycle", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "websocket-platform-secret-32-chars");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("disconnects an established socket and rejects HTTP after bearer revocation", async () => {
    const h = makeHarness();
    const result = await mint(h.controller);
    const client = clientFor(result.token);

    await h.gateway.handleConnection(client);
    expect(client.scope).toMatchObject({
      organizationId: SCOPE.organizationId,
      principal: "end-user",
    });
    expect(client.disconnect).not.toHaveBeenCalled();

    h.state.bearer.revokedAt = new Date();
    await expect(new ScopeGuard(h.auth).canActivate(httpContext(result.token))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await h.gateway.handleLeaveThread(client, { threadId: "thread-ws" });

    expect(client.emit).toHaveBeenCalledWith("error", {
      code: "SESSION_REVOKED_OR_EXPIRED",
      message: "Session authorization is no longer active.",
    });
    expect(client.leave).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledOnce();
    h.gateway.handleDisconnect(client);
  });

  it("disconnects an established socket on bearer expiry", async () => {
    const h = makeHarness();
    const result = await mint(h.controller);
    const client = clientFor(result.token);
    await h.gateway.handleConnection(client);

    h.state.bearer.expiresAt = new Date(Date.now() - 1);
    await h.gateway.handleLeaveThread(client, { threadId: "thread-ws" });

    expect(client.emit).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ code: "SESSION_REVOKED_OR_EXPIRED" }),
    );
    expect(client.disconnect).toHaveBeenCalledOnce();
    h.gateway.handleDisconnect(client);
  });

  it("schedules disconnect at signed JWT expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    const h = makeHarness();
    h.state.bearer.expiresAt = null;
    const token = await h.auth.createEntitySessionToken(
      {
        organizationId: SCOPE.organizationId,
        projectId: SCOPE.projectId,
        environmentId: SCOPE.environmentId,
        userId: SCOPE.userId,
        entityId: SCOPE.entityId,
      },
      h.state.bearer.id,
      1,
    );
    const client = clientFor(token!);
    await h.gateway.handleConnection(client);

    await vi.advanceTimersByTimeAsync(1_001);

    expect(client.emit).toHaveBeenCalledWith("error", {
      code: "SESSION_EXPIRED",
      message: "Session token expired.",
    });
    expect(client.disconnect).toHaveBeenCalledOnce();
    h.gateway.handleDisconnect(client);
  });

  it("keeps a real entity-minted browser token out of operator rooms and other users' threads", async () => {
    const h = makeHarness();
    const entitySecret = "websocket-entity-secret-32-chars";
    vi.spyOn(h.auth, "resolveEntityServiceSecret").mockResolvedValue(entitySecret);
    const token = mintSessionToken({
      serviceSecret: entitySecret,
      claims: SCOPE,
      ttlSeconds: 300,
    });
    const client = clientFor(token);

    await h.gateway.handleConnection(client);

    expect(client.scope.principal).toBe("end-user");
    expect(client.join).toHaveBeenCalledWith(
      `user:${SCOPE.organizationId}:${SCOPE.projectId}:${SCOPE.environmentId}:${SCOPE.userId}`,
    );
    expect(client.join).not.toHaveBeenCalledWith(
      `scope:${SCOPE.organizationId}:${SCOPE.projectId}:${SCOPE.environmentId}`,
    );

    await h.gateway.handleJoinThread(client, { threadId: "thread-other-user" });

    expect(h.conversationService.getThread).toHaveBeenCalledWith(
      "thread-other-user",
      expect.objectContaining({ userId: SCOPE.userId, principal: "end-user" }),
      { allUsers: false },
    );
    expect(client.join).not.toHaveBeenCalledWith("thread:thread-other-user");
    expect(client.emit).toHaveBeenCalledWith("error", { message: "thread not found" });
    h.gateway.handleDisconnect(client);
  });
});
