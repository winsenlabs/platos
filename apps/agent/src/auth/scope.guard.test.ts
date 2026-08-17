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
import { ScopeGuard } from "./scope.guard";
import { AuthService } from "./auth.service";
import type { ExecutionContext } from "@nestjs/common";

type HeaderMap = Record<string, string | undefined>;

function mockExecutionContext(
  headers: HeaderMap = {},
  url = "/api/v1/agent/threads",
  preScoped?: Record<string, unknown>,
  method = "GET",
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

describe("ScopeGuard — health/test allowlist", () => {
  it("allows /api/health without auth", async () => {
    const guard = new ScopeGuard();
    await expect(guard.canActivate(mockExecutionContext({}, "/api/health"))).resolves.toBe(true);
  });

  it("allows /test/* without auth", async () => {
    const guard = new ScopeGuard();
    await expect(guard.canActivate(mockExecutionContext({}, "/test/ping"))).resolves.toBe(true);
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
    const req = (ctx.switchToHttp().getRequest() as any);
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
    const req = (ctx.switchToHttp().getRequest() as any);
    expect(req.scope.entityId).toBe("fandesk-main");
    expect(req.scope.userToken).toBe("opaque.user.jwt");
  });

  it("allows trusted direct-header control-plane routes without raw bearer material", async () => {
    const authService = { verifyAccessKey: vi.fn().mockResolvedValue(false) };
    const guard = new ScopeGuard(authService as any);
    const ctx = mockExecutionContext(
      {
        "x-platos-organization-id": "org_1",
        "x-platos-project-id": "proj_1",
        "x-platos-environment-id": "env_1",
        "x-platos-user-id": "user_1",
      },
      "/api/v1/agent/threads",
      undefined,
      "POST",
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(authService.verifyAccessKey).not.toHaveBeenCalled();
    expect((ctx.switchToHttp().getRequest() as any).scope.principal).toBe("operator");
  });

  it("continues to reject proxied raw-header requests before AccessKey verification", async () => {
    const authService = { verifyAccessKey: vi.fn().mockResolvedValue(true) };
    const guard = new ScopeGuard(authService as any);
    const ctx = mockExecutionContext({
      "x-forwarded-for": "203.0.113.7",
      "x-platos-organization-id": "org_1",
      "x-platos-project-id": "proj_1",
      "x-platos-environment-id": "env_1",
      "x-platos-user-id": "user_1",
      "x-platos-api-key": "plt_external_attempt",
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.verifyAccessKey).not.toHaveBeenCalled();
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
    const req = (ctx.switchToHttp().getRequest() as any);
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
        UnauthorizedException,
      );
    },
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
      UnauthorizedException,
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
      );
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      process.env.PLATOS_INTERNAL_AUTH_TOKEN = prevToken;
    }
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
      const ctx = mockExecutionContext({}, "/api/v1/agent/internal/compaction");
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
        const ctx = mockExecutionContext({ "x-platos-internal-auth": "WRONG" }, path);
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
        const ctx = mockExecutionContext({}, path);
        await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
      } finally {
        process.env.PLATOS_INTERNAL_AUTH_TOKEN = prevToken;
      }
    });
  }
});
