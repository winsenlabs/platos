/**
 * PPR-35 — ScopeGuard unit tests.
 *
 * Covers all three auth paths the guard flows through:
 *   1. Pre-scoped request (WebSocket handshake already set request.scope)
 *   2. Session-token JWT (Path 1) — delegates to AuthService.validateSessionToken
 *   3. Direct headers (Path 2) — internal/trusted only, rejected when X-Forwarded-For present
 *
 * The token path uses a real AuthService with a small clean-tenancy Prisma
 * shim so bearer lifecycle and canonical ancestry are exercised together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { mintSessionToken } from "@platosdev/token-mint";
import {
  isPublicDocsMcpTransport,
  isPublicChannelCallback,
  isPublicMcpTransport,
  isPublicOAuthRoute,
  isPublicTokenMintRoute,
  ScopeGuard,
} from "./scope.guard";
import { AuthService } from "./auth.service";
import { AgentController } from "../agent-runtime/agent.controller";
import type { ExecutionContext } from "@nestjs/common";

type HeaderMap = Record<string, string | undefined>;

function mockExecutionContext(
  headers: HeaderMap = {},
  url = "/api/v1/agent/threads",
  preScoped?: Record<string, unknown>,
  method = "GET"
): ExecutionContext {
  const request: Record<string, unknown> = { headers, url, method };
  if (preScoped) request.scope = preScoped;
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function makeAuthHarness() {
  const scope = {
    organizationId: "org_A",
    projectId: "proj_A",
    environmentId: "env_A",
    userId: "user_A",
    entityId: "ent_A",
  };
  const state = {
    bearer: {
      id: "bearer_A",
      environmentId: scope.environmentId,
      revokedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 60_000) as Date | null,
      entity: {
        externalId: scope.entityId,
        project: { id: scope.projectId, organizationId: scope.organizationId },
      },
    },
    environment: {
      id: scope.environmentId,
      project: { id: scope.projectId, organizationId: scope.organizationId },
    },
    accessKey: null as null | { id: string; keyHash: string; allowedOrigins: string[] },
    agentBinding: { id: "binding_A", agentId: "agent_A" } as null | { id: string; agentId: string },
  };
  const prisma = {
    mcpBearerToken: {
      findUnique: vi.fn(async () => state.bearer),
      updateMany: vi.fn(async () => ({
        count:
          !state.bearer.revokedAt &&
          (!state.bearer.expiresAt || state.bearer.expiresAt.getTime() > Date.now())
            ? 1
            : 0,
      })),
    },
    environment: {
      findUnique: vi.fn(async () => state.environment),
    },
    accessKey: {
      findMany: vi.fn(async () => (state.accessKey ? [state.accessKey] : [])),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentBinding: {
      findFirst: vi.fn(async ({ where }: any) => {
        const binding = state.agentBinding;
        if (!binding) return null;
        return binding.agentId === where.agentId &&
          where.environmentId === scope.environmentId &&
          where.environment.projectId === scope.projectId &&
          where.environment.project.organizationId === scope.organizationId
          ? { id: binding.id }
          : null;
      }),
    },
  };
  const auth = new AuthService(prisma as any, {} as any);
  // ScopeGuard owns token validation and delegates key verification. The
  // AccessKey data model is covered in AuthService tests; this lightweight
  // session fixture does not model EnvironmentRuntimeAuthorization.
  const verifyAccessKey = vi.spyOn(auth, "verifyAccessKey").mockResolvedValue(null);
  return {
    scope,
    state,
    prisma,
    auth,
    verifyAccessKey,
  };
}

describe("ScopeGuard — pre-scoped short-circuit", () => {
  it("returns true when request.scope is already set (WS handshake path)", async () => {
    const guard = new ScopeGuard();
    const ctx = mockExecutionContext({}, "/anything", {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      userId: "user_1",
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

describe("ScopeGuard — health allowlist", () => {
  it("allows /api/health without auth", async () => {
    const guard = new ScopeGuard();
    await expect(guard.canActivate(mockExecutionContext({}, "/api/health"))).resolves.toBe(true);
  });

  it("does not reserve a public /test/* prefix in the global guard", async () => {
    const guard = new ScopeGuard();
    await expect(guard.canActivate(mockExecutionContext({}, "/test/ping"))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe("ScopeGuard — exact MCP protocol isolation", () => {
  it.each([
    ["POST", "/mcp/platform"],
    ["GET", "/mcp/platform/sse?sessionId=one"],
    ["POST", "/mcp/entity/entity-1"],
    ["GET", "/mcp/entity/entity-1/events/subscribe?cursor=one"],
  ])("recognizes public %s %s", (method, url) => {
    expect(isPublicMcpTransport(method, url)).toBe(true);
  });

  it.each([
    ["GET", "/mcp/platform"],
    ["POST", "/mcp/platform/tokens"],
    ["GET", "/mcp/entity/entity-1/tokens"],
    ["PATCH", "/mcp/entity/entity-1/inject-context"],
    ["POST", "/mcp/entity/entity-1/tool-acl/bulk"],
  ])("keeps management %s %s behind normal scope auth", (method, url) => {
    expect(isPublicMcpTransport(method, url)).toBe(false);
  });
});

describe("ScopeGuard — exact public self-auth route isolation", () => {
  it.each([
    ["GET", "/mcp"],
    ["POST", "/mcp?client=inspector"],
    ["GET", "/mcp/docs"],
    ["GET", "/mcp/docs/sse?sessionId=one"],
    ["POST", "/mcp/messages?sessionId=one"],
    ["POST", "/mcp/docs/messages?sessionId=one"],
  ])("recognizes public Docs MCP %s %s", (method, url) => {
    expect(isPublicDocsMcpTransport(method, url)).toBe(true);
  });

  it.each([
    ["DELETE", "/mcp"],
    ["POST", "/mcp/sse"],
    ["GET", "/mcp/messages"],
    ["GET", "/mcp/docs-admin"],
    ["POST", "/mcp/docs/tokens"],
    ["POST", "/mcp/docs/messages/extra"],
  ])("keeps Docs MCP near-miss %s %s behind normal scope auth", (method, url) => {
    expect(isPublicDocsMcpTransport(method, url)).toBe(false);
  });

  it.each([
    ["POST", "/api/v1/public/guest-token"],
    ["POST", "/api/v1/entities/walle-mcp/session-tokens?ttl=300"],
  ])("recognizes public token mint %s %s", (method, url) => {
    expect(isPublicTokenMintRoute(method, url)).toBe(true);
  });

  it.each([
    ["GET", "/api/v1/public/guest-token"],
    ["POST", "/api/v1/public/guest-token/rotate"],
    ["POST", "/api/v1/publicity/guest-token"],
    ["GET", "/api/v1/entities/walle-mcp/session-tokens"],
    ["POST", "/api/v1/entities/walle-mcp/session-tokens/rotate"],
    ["POST", "/api/v1/entities/walle-mcp/not-session-tokens"],
  ])("keeps token-mint near-miss %s %s behind normal scope auth", (method, url) => {
    expect(isPublicTokenMintRoute(method, url)).toBe(false);
  });
});

describe("ScopeGuard — exact channel callback isolation", () => {
  it.each([
    ["POST", "/api/v1/channels/inbound/connection_1/secret_1"],
    ["GET", "/api/v1/channels/inbound/connection_1/secret_1"],
    ["GET", "/api/v1/channels/oauth/app_1/install"],
    ["GET", "/api/v1/channels/oauth/app_1/callback?code=one"],
    ["POST", "/api/v1/channels/apps/app_1/events"],
    ["GET", "/api/v1/channels/link/callback?code=one"],
    ["GET", "/api/v1/channels/link/nonce_1"],
  ])("recognizes provider callback %s %s", (method, url) => {
    expect(isPublicChannelCallback(method, url)).toBe(true);
  });

  it.each([
    ["GET", "/api/v1/channels/apps/app_1"],
    ["POST", "/api/v1/channels/oauth/app_1/install"],
    ["GET", "/api/v1/channels/oauth/app_1/callback/admin"],
    ["POST", "/api/v1/channels/apps/app_1/events/replay"],
    ["POST", "/api/v1/channels/link/callback"],
    ["GET", "/api/v1/channels/inbound/connection_1"],
  ])("keeps non-callback sibling %s %s scoped", (method, url) => {
    expect(isPublicChannelCallback(method, url)).toBe(false);
  });
});

describe("ScopeGuard — exact OAuth protocol isolation", () => {
  it.each([
    ["GET", "/.well-known/oauth-authorization-server"],
    ["POST", "/oauth/token"],
    ["GET", "/oauth/authorize?client_id=one"],
    ["POST", "/oauth/entity/entity_1/register"],
    ["GET", "/oauth/entity/entity_1/authorize"],
    ["POST", "/oauth/entity/entity_1/authorize/anonymous"],
    ["GET", "/oauth/entity/entity_1/oidc-callback?code=one"],
  ])("recognizes OAuth endpoint %s %s", (method, url) => {
    expect(isPublicOAuthRoute(method, url)).toBe(true);
  });

  it.each([
    ["GET", "/oauth"],
    ["GET", "/oauth/token"],
    ["POST", "/oauth/entity/entity_1/authorize"],
    ["GET", "/oauth/entity/entity_1/token"],
    ["POST", "/oauth/entity/entity_1/oidc-callback"],
    ["GET", "/oauth/admin/tokens"],
    ["GET", "/.well-known/private-config"],
  ])("keeps OAuth near-miss %s %s scoped", (method, url) => {
    expect(isPublicOAuthRoute(method, url)).toBe(false);
  });
});

describe("ScopeGuard — Path 2 direct headers", () => {
  it("accepts 4-header scope from trusted internal origin (no X-Forwarded-For)", async () => {
    const guard = new ScopeGuard();
    const ctx = mockExecutionContext({
      "x-platos-organization-id": "org_1",
      "x-platos-project-id": "proj_1",
      "x-platos-environment-id": "env_1",
      "x-platos-user-id": "user_1",
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest() as any;
    expect(req.scope.organizationId).toBe("org_1");
    expect(req.scope.projectId).toBe("proj_1");
    expect(req.scope.environmentId).toBe("env_1");
    expect(req.scope.userId).toBe("user_1");
  });

  it("rejects direct-header request when X-Forwarded-For is present (external origin)", async () => {
    const guard = new ScopeGuard();
    const ctx = mockExecutionContext({
      "x-forwarded-for": "203.0.113.7",
      "x-platos-organization-id": "org_1",
      "x-platos-project-id": "proj_1",
      "x-platos-environment-id": "env_1",
      "x-platos-user-id": "user_1",
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects when any of the four required headers is missing", async () => {
    const guard = new ScopeGuard();
    const ctx = mockExecutionContext({
      "x-platos-organization-id": "org_1",
      "x-platos-project-id": "proj_1",
      // environmentId intentionally missing
      "x-platos-user-id": "user_1",
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("propagates optional userToken and entityId when supplied", async () => {
    const guard = new ScopeGuard();
    const ctx = mockExecutionContext({
      "x-platos-organization-id": "org_1",
      "x-platos-project-id": "proj_1",
      "x-platos-environment-id": "env_1",
      "x-platos-user-id": "user_1",
      "x-platos-entity-id": "fandesk-main",
      "x-platos-user-token": "opaque.user.jwt",
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest() as any;
    expect(req.scope.entityId).toBe("fandesk-main");
    expect(req.scope.userToken).toBe("opaque.user.jwt");
  });

  it.each([
    ["GET", "/api/v1/agent/access-key"],
    ["POST", "/api/v1/agent/access-key"],
    ["DELETE", "/api/v1/agent/access-key"],
    ["POST", "/api/v1/agent/access-key/origins?from=dashboard"],
  ])(
    "allows trusted direct-header AccessKey lifecycle %s %s without raw bearer material",
    async (method, url) => {
      const authService = { verifyAccessKey: vi.fn().mockResolvedValue(false) };
      const guard = new ScopeGuard(authService as any);
      const ctx = mockExecutionContext(
        {
          "x-platos-organization-id": "org_1",
          "x-platos-project-id": "proj_1",
          "x-platos-environment-id": "env_1",
          "x-platos-user-id": "user_1",
        },
        url,
        undefined,
        method
      );

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(authService.verifyAccessKey).not.toHaveBeenCalled();
      expect((ctx.switchToHttp().getRequest() as any).scope.principal).toBe("operator");
    }
  );

  it.each([
    ["POST", "/api/v1/agent/threads"],
    ["GET", "/api/v1/agent/providers"],
    ["GET", "/api/v1/agent/access-key/origins"],
    ["POST", "/api/v1/agent/access-key/"],
    ["POST", "/api/v1/agent/access-key/rotate"],
    ["POST", "/api/v1/agent/access-key/origins/extra?from=dashboard"],
  ])(
    "rejects trusted direct-header %s %s when the AccessKey is missing or invalid",
    async (method, url) => {
      const authService = { verifyAccessKey: vi.fn().mockResolvedValue(false) };
      const guard = new ScopeGuard(authService as any);
      const ctx = mockExecutionContext(
        {
          "x-platos-organization-id": "org_1",
          "x-platos-project-id": "proj_1",
          "x-platos-environment-id": "env_1",
          "x-platos-user-id": "user_1",
        },
        url,
        undefined,
        method
      );

      await expect(guard.canActivate(ctx)).resolves.toBe(false);
      expect(authService.verifyAccessKey).toHaveBeenCalledWith(
        {
          organizationId: "org_1",
          projectId: "proj_1",
          environmentId: "env_1",
          userId: "user_1",
        },
        undefined,
        undefined
      );
      const response = ctx.switchToHttp().getResponse() as any;
      expect(response.status).toHaveBeenCalledWith(401);
      expect(response.json).toHaveBeenCalledWith({
        error: "INVALID_ACCESS_KEY",
        message: "X-Platos-Api-Key is missing or invalid for this scope.",
      });
    }
  );

  it("allows an arbitrary trusted direct-header route with a valid AccessKey", async () => {
    const authService = { verifyAccessKey: vi.fn().mockResolvedValue(true) };
    const guard = new ScopeGuard(authService as any);
    const ctx = mockExecutionContext(
      {
        "x-platos-organization-id": "org_1",
        "x-platos-project-id": "proj_1",
        "x-platos-environment-id": "env_1",
        "x-platos-user-id": "user_1",
        "x-platos-api-key": "platos_live_valid",
        origin: "https://app.example",
      },
      "/api/v1/agent/threads?agentId=agent_1",
      undefined,
      "POST"
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(authService.verifyAccessKey).toHaveBeenCalledWith(
      {
        organizationId: "org_1",
        projectId: "proj_1",
        environmentId: "env_1",
        userId: "user_1",
      },
      "platos_live_valid",
      "https://app.example"
    );
  });

  it("allows a server-authenticated dashboard request without retaining an Environment AccessKey", async () => {
    const previous = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = "dashboard-control-plane-token-32chars";
    try {
      const authService = { verifyAccessKey: vi.fn().mockResolvedValue(false) };
      const guard = new ScopeGuard(authService as any);
      const ctx = mockExecutionContext(
        {
          "x-platos-organization-id": "org_1",
          "x-platos-project-id": "proj_1",
          "x-platos-environment-id": "env_1",
          "x-platos-user-id": "user_1",
          "x-platos-internal-auth": "dashboard-control-plane-token-32chars",
        },
        "/api/v1/agent/entities/entity_1"
      );

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(authService.verifyAccessKey).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.PLATOS_INTERNAL_AUTH_TOKEN;
      else process.env.PLATOS_INTERNAL_AUTH_TOKEN = previous;
    }
  });

  it("preserves a canonically validated Agent pin on the operator control-plane scope", async () => {
    const previous = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = "dashboard-control-plane-token-32chars";
    try {
      const h = makeAuthHarness();
      const ctx = mockExecutionContext(
        {
          "x-platos-organization-id": h.scope.organizationId,
          "x-platos-project-id": h.scope.projectId,
          "x-platos-environment-id": h.scope.environmentId,
          "x-platos-user-id": h.scope.userId,
          "x-platos-agent-id": "agent_A",
          "x-platos-internal-auth": "dashboard-control-plane-token-32chars",
        },
        "/api/v1/memory"
      );

      await expect(new ScopeGuard(h.auth).canActivate(ctx)).resolves.toBe(true);
      expect((ctx.switchToHttp().getRequest() as any).scope).toMatchObject({
        principal: "operator",
        agentId: "agent_A",
      });
      expect(h.prisma.agentBinding.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            agentId: "agent_A",
            environmentId: h.scope.environmentId,
          }),
        })
      );
    } finally {
      if (previous === undefined) delete process.env.PLATOS_INTERNAL_AUTH_TOKEN;
      else process.env.PLATOS_INTERNAL_AUTH_TOKEN = previous;
    }
  });

  it("rejects an Agent pin outside canonical scope and never trusts it as an arbitrary header", async () => {
    const previous = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = "dashboard-control-plane-token-32chars";
    try {
      const h = makeAuthHarness();
      const ctx = mockExecutionContext(
        {
          "x-platos-organization-id": h.scope.organizationId,
          "x-platos-project-id": h.scope.projectId,
          "x-platos-environment-id": h.scope.environmentId,
          "x-platos-user-id": h.scope.userId,
          "x-platos-agent-id": "agent_foreign",
          "x-platos-internal-auth": "dashboard-control-plane-token-32chars",
        },
        "/api/v1/memory"
      );

      await expect(new ScopeGuard(h.auth).canActivate(ctx)).resolves.toBe(false);
      const response = ctx.switchToHttp().getResponse() as any;
      expect(response.status).toHaveBeenCalledWith(403);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "INVALID_AGENT_SCOPE" })
      );
      expect((ctx.switchToHttp().getRequest() as any).scope).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PLATOS_INTERNAL_AUTH_TOKEN;
      else process.env.PLATOS_INTERNAL_AUTH_TOKEN = previous;
    }
  });

  it("rejects an otherwise valid Agent pin without server control-plane authentication", async () => {
    const h = makeAuthHarness();
    const ctx = mockExecutionContext(
      {
        "x-platos-organization-id": h.scope.organizationId,
        "x-platos-project-id": h.scope.projectId,
        "x-platos-environment-id": h.scope.environmentId,
        "x-platos-user-id": h.scope.userId,
        "x-platos-agent-id": "agent_A",
      },
      "/api/v1/memory"
    );

    await expect(new ScopeGuard(h.auth).canActivate(ctx)).resolves.toBe(false);
    expect(h.prisma.agentBinding.findFirst).not.toHaveBeenCalled();
    const response = ctx.switchToHttp().getResponse() as any;
    expect(response.status).toHaveBeenCalledWith(403);
  });
});

describe("ScopeGuard — Path 1 session token", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "scope-guard-platform-secret-32-chars");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts an active bearer-backed token as an end user", async () => {
    const h = makeAuthHarness();
    const guard = new ScopeGuard(h.auth);
    const token = await h.auth.createEntitySessionToken(h.scope as any, "bearer_A", 300);
    const ctx = mockExecutionContext({
      "x-platos-session-token": token!,
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest() as any;
    expect(req.scope).toMatchObject({
      organizationId: h.scope.organizationId,
      entityId: h.scope.entityId,
      principal: "end-user",
    });
  });

  it("classifies an unbound platform token as an operator", async () => {
    const h = makeAuthHarness();
    const token = await h.auth.createPlatformSessionToken({
      organizationId: h.scope.organizationId,
      projectId: h.scope.projectId,
      environmentId: h.scope.environmentId,
      userId: h.scope.userId,
    });
    const ctx = mockExecutionContext({ "x-platos-session-token": token! });
    await expect(new ScopeGuard(h.auth).canActivate(ctx)).resolves.toBe(true);
    expect((ctx.switchToHttp().getRequest() as any).scope.principal).toBe("operator");
  });

  it("keeps guest platform tokens in the end-user tier", async () => {
    const h = makeAuthHarness();
    const token = await h.auth.createPlatformSessionToken({
      organizationId: h.scope.organizationId,
      projectId: h.scope.projectId,
      environmentId: h.scope.environmentId,
      userId: h.scope.userId,
      extraClaims: { isGuest: true },
    });
    const ctx = mockExecutionContext({ "x-platos-session-token": token! });
    await expect(new ScopeGuard(h.auth).canActivate(ctx)).resolves.toBe(true);
    expect((ctx.switchToHttp().getRequest() as any).scope.principal).toBe("end-user");
  });

  it("denies a real entity-minted browser token access to operator budget routes", async () => {
    const h = makeAuthHarness();
    const entitySecret = "scope-guard-entity-secret-32-chars";
    vi.spyOn(h.auth, "resolveEntityServiceSecret").mockResolvedValue(entitySecret);
    const token = mintSessionToken({
      serviceSecret: entitySecret,
      claims: h.scope,
      ttlSeconds: 300,
    });
    const ctx = mockExecutionContext({ "x-platos-session-token": token }, "/api/v1/agent/budgets");

    await expect(new ScopeGuard(h.auth).canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest() as any;
    expect(req.scope.principal).toBe("end-user");

    const budgetService = {
      list: vi.fn(),
      evaluate: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      override: vi.fn(),
    };
    const controller: any = Object.create(AgentController.prototype);
    controller.budgetService = budgetService;

    const calls = [
      () => controller.listBudgets(req),
      () => controller.budgetStatus(req),
      () =>
        controller.upsertBudget(req, {
          scopeType: "environment",
          period: "monthly",
          limitCents: 10_000,
        }),
      () => controller.deleteBudget(req, "cap-1"),
      () => controller.overrideBudget(req, "cap-1", { minutes: 60 }),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        status: 403,
        response: { error: "OPERATOR_ONLY" },
      });
    }

    expect(budgetService.list).not.toHaveBeenCalled();
    expect(budgetService.evaluate).not.toHaveBeenCalled();
    expect(budgetService.upsert).not.toHaveBeenCalled();
    expect(budgetService.delete).not.toHaveBeenCalled();
    expect(budgetService.override).not.toHaveBeenCalled();
  });

  it("rejects a real public guest principal before every budget service read or mutation", async () => {
    const h = makeAuthHarness();
    const token = await h.auth.createPlatformSessionToken({
      organizationId: h.scope.organizationId,
      projectId: h.scope.projectId,
      environmentId: h.scope.environmentId,
      userId: h.scope.userId,
      extraClaims: { isGuest: true },
    });
    const ctx = mockExecutionContext({ "x-platos-session-token": token! }, "/api/v1/agent/budgets");

    await expect(new ScopeGuard(h.auth).canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest() as any;
    expect(req.scope.principal).toBe("end-user");

    const budgetService = {
      list: vi.fn(),
      evaluate: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      override: vi.fn(),
    };
    const controller: any = Object.create(AgentController.prototype);
    controller.budgetService = budgetService;

    const calls = [
      () => controller.listBudgets(req),
      () => controller.budgetStatus(req),
      () =>
        controller.upsertBudget(req, {
          scopeType: "environment",
          period: "monthly",
          limitCents: 10_000,
        }),
      () => controller.deleteBudget(req, "cap-1"),
      () => controller.overrideBudget(req, "cap-1", { minutes: 60 }),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        status: 403,
        response: {
          error: "OPERATOR_ONLY",
          message:
            "This endpoint requires an operator (control-plane) credential. End-user / entity / guest tokens are not permitted.",
        },
      });
    }

    expect(budgetService.list).not.toHaveBeenCalled();
    expect(budgetService.evaluate).not.toHaveBeenCalled();
    expect(budgetService.upsert).not.toHaveBeenCalled();
    expect(budgetService.delete).not.toHaveBeenCalled();
    expect(budgetService.override).not.toHaveBeenCalled();
  });

  it.each(["revoked", "expired", "forged ancestry"])(
    "rejects a token whose bearer is %s",
    async (condition) => {
      const h = makeAuthHarness();
      const token = await h.auth.createEntitySessionToken(h.scope as any, "bearer_A", 300);
      if (condition === "revoked") h.state.bearer.revokedAt = new Date();
      if (condition === "expired") h.state.bearer.expiresAt = new Date(Date.now() - 1);
      if (condition === "forged ancestry") h.state.bearer.entity.project.id = "other-project";

      const ctx = mockExecutionContext({ "x-platos-session-token": token! });
      await expect(new ScopeGuard(h.auth).canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException
      );
    }
  );

  it("runs the AccessKey check only after session validation succeeds", async () => {
    const h = makeAuthHarness();
    const token = await h.auth.createEntitySessionToken(h.scope as any, "bearer_A", 300);
    const ctx = mockExecutionContext({ "x-platos-session-token": token! });

    await expect(new ScopeGuard(h.auth).canActivate(ctx)).resolves.toBe(true);
    expect(h.prisma.mcpBearerToken.updateMany).toHaveBeenCalledOnce();
    expect(h.verifyAccessKey).toHaveBeenCalledOnce();
  });

  it("rejects the removed legacy two-part token format", async () => {
    const h = makeAuthHarness();
    const ctx = mockExecutionContext({ "x-platos-session-token": "payload.signature" });
    await expect(new ScopeGuard(h.auth).canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });
});

describe("ScopeGuard — admin token path", () => {
  it("passes privacy routes to their admin-tier credential verifier without a static secret", async () => {
    const guard = new ScopeGuard();
    const ctx = mockExecutionContext({}, "/api/v1/agent/admin/privacy/erasures/op_1");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("lets /api/v1/agent/monitoring/cost/catalog through with correct admin token", async () => {
    const prevToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = "admin-secret-for-test";
    try {
      const guard = new ScopeGuard();
      const ctx = mockExecutionContext(
        { "x-platos-internal-auth": "admin-secret-for-test" },
        "/api/v1/agent/monitoring/cost/catalog",
        undefined,
        "POST"
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    } finally {
      process.env.PLATOS_INTERNAL_AUTH_TOKEN = prevToken;
    }
  });

  it("rejects /api/v1/agent/monitoring/cost/catalog with wrong admin token", async () => {
    const prevToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = "admin-secret-for-test";
    try {
      const guard = new ScopeGuard();
      const ctx = mockExecutionContext(
        { "x-platos-internal-auth": "WRONG" },
        "/api/v1/agent/monitoring/cost/catalog",
        undefined,
        "POST"
      );
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      process.env.PLATOS_INTERNAL_AUTH_TOKEN = prevToken;
    }
  });

  it("allows only the registered verb for internal callbacks and observability status", async () => {
    const prevToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = "admin-secret-for-test";
    const headers = { "x-platos-internal-auth": "admin-secret-for-test" };
    try {
      const guard = new ScopeGuard();
      await expect(
        guard.canActivate(
          mockExecutionContext(
            headers,
            "/api/v1/agent/monitoring/observability/status",
            undefined,
            "GET"
          )
        )
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(
          mockExecutionContext(
            headers,
            "/api/v1/agent/monitoring/observability/status",
            undefined,
            "POST"
          )
        )
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        guard.canActivate(
          mockExecutionContext(headers, "/api/v1/agent/internal/compaction/extra", undefined, "POST")
        )
      ).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      process.env.PLATOS_INTERNAL_AUTH_TOKEN = prevToken;
    }
  });

  it("lets the HMAC-authenticated env invalidation callback reach its controller", async () => {
    const guard = new ScopeGuard();
    await expect(
      guard.canActivate(mockExecutionContext({}, "/internal/env/invalidate", undefined, "POST"))
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(mockExecutionContext({}, "/internal/env/invalidate/extra", undefined, "POST"))
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // LAUNCH-11 — durable compaction callback.
  it("lets /api/v1/agent/internal/compaction through with correct admin token", async () => {
    const prevToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = "admin-secret-for-test";
    try {
      const guard = new ScopeGuard();
      const ctx = mockExecutionContext(
        { "x-platos-internal-auth": "admin-secret-for-test" },
        "/api/v1/agent/internal/compaction",
        undefined,
        "POST"
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    } finally {
      process.env.PLATOS_INTERNAL_AUTH_TOKEN = prevToken;
    }
  });

  it("rejects /api/v1/agent/internal/compaction with wrong admin token", async () => {
    const prevToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = "admin-secret-for-test";
    try {
      const guard = new ScopeGuard();
      const ctx = mockExecutionContext(
        { "x-platos-internal-auth": "WRONG" },
        "/api/v1/agent/internal/compaction",
        undefined,
        "POST"
      );
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      process.env.PLATOS_INTERNAL_AUTH_TOKEN = prevToken;
    }
  });

  it("rejects /api/v1/agent/internal/compaction without admin token entirely", async () => {
    const prevToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = "admin-secret-for-test";
    try {
      const guard = new ScopeGuard();
      const ctx = mockExecutionContext({}, "/api/v1/agent/internal/compaction", undefined, "POST");
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      process.env.PLATOS_INTERNAL_AUTH_TOKEN = prevToken;
    }
  });

  // REFACTOR (control-plane + trigger substrate) — the durable-execution
  // callbacks (durable-turn / employee-run / skill-run) reuse the same
  // admin-token bypass as compaction. Same accept/reject contract.
  for (const path of [
    "/api/v1/agent/internal/durable-turn",
    "/api/v1/agent/internal/employee-run",
    "/api/v1/agent/internal/skill-run",
  ]) {
    it(`lets ${path} through with correct admin token`, async () => {
      const prevToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
      process.env.PLATOS_INTERNAL_AUTH_TOKEN = "admin-secret-for-test";
      try {
        const guard = new ScopeGuard();
        const ctx = mockExecutionContext(
          { "x-platos-internal-auth": "admin-secret-for-test" },
          path,
          undefined,
          "POST"
        );
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      } finally {
        process.env.PLATOS_INTERNAL_AUTH_TOKEN = prevToken;
      }
    });

    it(`rejects ${path} with wrong admin token`, async () => {
      const prevToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
      process.env.PLATOS_INTERNAL_AUTH_TOKEN = "admin-secret-for-test";
      try {
        const guard = new ScopeGuard();
        const ctx = mockExecutionContext(
          { "x-platos-internal-auth": "WRONG" },
          path,
          undefined,
          "POST"
        );
        await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
      } finally {
        process.env.PLATOS_INTERNAL_AUTH_TOKEN = prevToken;
      }
    });

    it(`rejects ${path} without admin token entirely`, async () => {
      const prevToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
      process.env.PLATOS_INTERNAL_AUTH_TOKEN = "admin-secret-for-test";
      try {
        const guard = new ScopeGuard();
        const ctx = mockExecutionContext({}, path, undefined, "POST");
        await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
      } finally {
        process.env.PLATOS_INTERNAL_AUTH_TOKEN = prevToken;
      }
    });
  }
});
