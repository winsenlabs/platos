import { createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service";
import { ScopeGuard } from "./scope.guard";
import { SessionTokenController } from "./session-token.controller";

const RAW_BEARER = `plt_ent_${"a".repeat(64)}`;
const SCOPE = {
  organizationId: "org-controller",
  projectId: "project-controller",
  environmentId: "environment-controller",
  userId: "user-controller",
  entityId: "entity-controller",
};

function executionContext(token: string) {
  const request: any = {
    headers: { "x-platos-session-token": token },
    url: "/api/v1/agent/threads",
  };
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return {
    request,
    context: {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as any,
  };
}

function makeHarness() {
  const state = {
    bearer: {
      id: "bearer-controller",
      tokenHash: createHash("sha256").update(RAW_BEARER).digest("hex"),
      revokedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 90_000) as Date | null,
      entity: {
        externalId: SCOPE.entityId,
        project: { id: SCOPE.projectId, organizationId: SCOPE.organizationId },
      },
    },
    environment: {
      id: SCOPE.environmentId,
      project: { id: SCOPE.projectId, organizationId: SCOPE.organizationId },
    },
    activeCount: 1,
  };
  const prisma = {
    mcpBearerToken: {
      findUnique: vi.fn(async (args: any) => {
        if (args.where.tokenHash && args.where.tokenHash !== state.bearer.tokenHash) return null;
        if (args.where.id && args.where.id !== state.bearer.id) return null;
        return state.bearer;
      }),
      updateMany: vi.fn(async () => ({ count: state.activeCount })),
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
  return {
    state,
    prisma,
    auth,
    controller: new SessionTokenController(auth, prisma as any),
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: SCOPE.organizationId,
    projectId: SCOPE.projectId,
    environmentId: SCOPE.environmentId,
    userId: SCOPE.userId,
    ...overrides,
  } as any;
}

describe("SessionTokenController clean bearer mint", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "controller-platform-secret-32-chars");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mints canonical bearer-bound claims and validates through ScopeGuard", async () => {
    const h = makeHarness();
    const result = await h.controller.mint(
      SCOPE.entityId,
      `Bearer ${RAW_BEARER}`,
      body({
        ttlSeconds: 3600,
        claims: {
          organizationId: "forged-org",
          authorizationId: "forged-bearer",
          isGuest: true,
          custom: "preserved",
        },
      }),
    );

    expect(result.token.split(".")).toHaveLength(3);
    const payload = JSON.parse(
      Buffer.from(result.token.split(".")[1], "base64url").toString("utf8"),
    );
    expect(payload).toMatchObject({
      iss: "platos-platform",
      authorizationId: h.state.bearer.id,
      organizationId: SCOPE.organizationId,
      projectId: SCOPE.projectId,
      environmentId: SCOPE.environmentId,
      entityId: SCOPE.entityId,
      userId: SCOPE.userId,
      custom: "preserved",
    });
    expect(payload.isGuest).toBeUndefined();
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(90);

    const http = executionContext(result.token);
    await expect(new ScopeGuard(h.auth).canActivate(http.context)).resolves.toBe(true);
    expect(http.request.scope).toMatchObject({
      organizationId: SCOPE.organizationId,
      principal: "end-user",
    });
  });

  it.each([
    ["organization", { organizationId: "forged" }],
    ["project", { projectId: "forged" }],
    ["environment", { environmentId: "forged" }],
  ])("rejects forged request %s ancestry", async (_axis, overrides) => {
    const h = makeHarness();
    await expect(
      h.controller.mint(SCOPE.entityId, `Bearer ${RAW_BEARER}`, body(overrides)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each(["revoked", "expired", "revocation race"])(
    "rejects a %s entity bearer",
    async (condition) => {
      const h = makeHarness();
      if (condition === "revoked") h.state.bearer.revokedAt = new Date();
      if (condition === "expired") h.state.bearer.expiresAt = new Date(Date.now() - 1);
      if (condition === "revocation race") h.state.activeCount = 0;

      const error = await h.controller
        .mint(SCOPE.entityId, `Bearer ${RAW_BEARER}`, body())
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(401);
      expect(error.message).toBe("Invalid entity bearer");
    },
  );

  it("does not use a legacy entity delegate while minting or validating", async () => {
    const h = makeHarness();
    const result = await h.controller.mint(
      SCOPE.entityId,
      `Bearer ${RAW_BEARER}`,
      body(),
    );
    await expect(h.auth.validateSessionToken(result.token)).resolves.not.toBeNull();
    expect(h.prisma.mcpBearerToken.findUnique).toHaveBeenCalledTimes(2);
  });
});
