import { createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service";
import { ScopeGuard } from "./scope.guard";
import { EntityBearerDirectory } from "./entity-bearer.directory";
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
      environmentId: SCOPE.environmentId,
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
  vi.spyOn(auth, "verifyAccessKey").mockResolvedValue(null);
  return {
    state,
    prisma,
    auth,
    directory: new EntityBearerDirectory(prisma as any),
    controller: new SessionTokenController(auth, new EntityBearerDirectory(prisma as any)),
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

  it("rejects a same-project environment that is not owned by the PAT", async () => {
    const h = makeHarness();
    h.state.environment = {
      id: "environment-other",
      project: { id: SCOPE.projectId, organizationId: SCOPE.organizationId },
    };

    await expect(
      h.controller.mint(
        SCOPE.entityId,
        `Bearer ${RAW_BEARER}`,
        body({ environmentId: "environment-other" }),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.prisma.mcpBearerToken.updateMany).not.toHaveBeenCalled();
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

/**
 * WIN-258 T6 — the guards the controller could not tell apart.
 *
 * `session-token.controller.ts` decided admission in one ten-clause `if` and
 * threw the same `Invalid entity bearer` for every branch of it. Deleting any
 * single clause left every suite above green, because the only observable was a
 * 401 that all ten produce. That is this programme's fifth lesson exactly.
 *
 * The response is still one opaque 401 on purpose — a caller must not be able to
 * use the status to probe which of an entity id, project id, organization id or
 * environment id was the wrong one. The DISTINCTION lives inside the process,
 * and this is where it is asserted: each case names the clause it kills, and
 * removing that clause from `EntityBearerDirectory.authenticate` turns exactly
 * one of these red.
 */
describe("EntityBearerDirectory names every rejection the 401 hides", () => {
  const claim = {
    entityId: SCOPE.entityId,
    organizationId: SCOPE.organizationId,
    projectId: SCOPE.projectId,
    environmentId: SCOPE.environmentId,
  };
  const hash = createHash("sha256").update(RAW_BEARER).digest("hex");

  it("admits a live bearer whose claimed scope matches on every axis", async () => {
    const h = makeHarness();
    const result = await h.directory.authenticate(hash, claim, new Date());
    expect(result).toMatchObject({
      ok: true,
      bearer: {
        entityId: SCOPE.entityId,
        organizationId: SCOPE.organizationId,
        projectId: SCOPE.projectId,
        environmentId: SCOPE.environmentId,
      },
    });
  });

  it("distinguishes an unknown token from a revoked one", async () => {
    const h = makeHarness();
    await expect(
      h.directory.authenticate("not-a-known-hash", claim, new Date()),
    ).resolves.toEqual({ ok: false, reason: "unknown-token" });

    h.state.bearer.revokedAt = new Date();
    await expect(h.directory.authenticate(hash, claim, new Date())).resolves.toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("distinguishes an expired bearer from a live one at the boundary", async () => {
    const h = makeHarness();
    const expiry = new Date(Date.now() + 60_000);
    h.state.bearer.expiresAt = expiry;

    // Exactly AT the expiry the token is dead: the clause is `<=`, and an
    // assertion one millisecond either side is what tells `<` from `<=`.
    await expect(h.directory.authenticate(hash, claim, expiry)).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
    await expect(
      h.directory.authenticate(hash, claim, new Date(expiry.getTime() - 1)),
    ).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["entity-mismatch", { entityId: "entity-other" }],
    ["project-mismatch", { projectId: "project-other" }],
    ["organization-mismatch", { organizationId: "org-other" }],
  ])("names a %s rather than folding it into its neighbours", async (reason, override) => {
    const h = makeHarness();
    await expect(
      h.directory.authenticate(hash, { ...claim, ...override }, new Date()),
    ).resolves.toEqual({ ok: false, reason });
  });

  it("separates an environment the bearer does not carry from one that does not exist", async () => {
    const h = makeHarness();

    // The bearer's own environmentId disagrees with the claim.
    await expect(
      h.directory.authenticate(hash, { ...claim, environmentId: "environment-other" }, new Date()),
    ).resolves.toEqual({ ok: false, reason: "environment-mismatch" });

    // The claim agrees with the bearer, but no such environment row exists.
    h.state.bearer.environmentId = "environment-missing";
    await expect(
      h.directory.authenticate(hash, { ...claim, environmentId: "environment-missing" }, new Date()),
    ).resolves.toEqual({ ok: false, reason: "environment-unknown" });
  });

  it("refuses an environment owned by another project even when the ids line up", async () => {
    const h = makeHarness();
    h.state.bearer.environmentId = "environment-foreign";
    h.state.environment = {
      id: "environment-foreign",
      project: { id: "project-elsewhere", organizationId: SCOPE.organizationId },
    };

    await expect(
      h.directory.authenticate(hash, { ...claim, environmentId: "environment-foreign" }, new Date()),
    ).resolves.toEqual({ ok: false, reason: "environment-foreign" });
  });

  it("treats a lost compare-and-set as its own rejection, not a stale read", async () => {
    const h = makeHarness();
    h.state.activeCount = 0;

    await expect(h.directory.authenticate(hash, claim, new Date())).resolves.toEqual({
      ok: false,
      reason: "revoked-concurrently",
    });
    // The stamp was ATTEMPTED — the liveness re-check is the update itself, so
    // a directory that read-then-wrote would fail this.
    expect(h.prisma.mcpBearerToken.updateMany).toHaveBeenCalledTimes(1);
  });
});
