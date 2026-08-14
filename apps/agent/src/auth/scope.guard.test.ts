/**
 * PPR-35 — ScopeGuard unit tests.
 *
 * Covers all three auth paths the guard flows through:
 *   1. Pre-scoped request (WebSocket handshake already set request.scope)
 *   2. Session-token JWT (Path 1) — delegates to AuthService.validateSessionToken
 *   3. Direct headers (Path 2) — internal/trusted only, rejected when X-Forwarded-For present
 *
 * CLAUDE.md §9.11: Vitest only, never mock. We DON'T mock — we pass a real
 * AuthService instance with an in-memory Prisma shim that implements only
 * `platosConnectedEntity.findUnique`. That's the sole DB call the guard's
 * dependency graph triggers for these tests. No containers needed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import * as crypto from "node:crypto";
import { ScopeGuard } from "./scope.guard";
import { AuthService } from "./auth.service";
import type { ExecutionContext } from "@nestjs/common";

type HeaderMap = Record<string, string | undefined>;

function mockExecutionContext(
  headers: HeaderMap = {},
  url = "/api/v1/agent/threads",
  preScoped?: Record<string, unknown>,
): ExecutionContext {
  const request: Record<string, unknown> = { headers, url };
  if (preScoped) request.scope = preScoped;
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

/**
 * Minimal Prisma stub — only platosConnectedEntity.findUnique is hit by
 * AuthService.validateSessionToken, which is what ScopeGuard calls in path 1.
 * Our stub returns whatever serviceSecret the test seeds into the map.
 */
function makePrismaStub(entityTable: Map<string, { serviceSecret: string }>) {
  return {
    platosConnectedEntity: {
      findUnique: async (args: { where: { organizationId_projectId_entityId: { organizationId: string; projectId: string; entityId: string } } }) => {
        const { organizationId, projectId, entityId } = args.where.organizationId_projectId_entityId;
        const key = `${organizationId}:${projectId}:${entityId}`;
        return entityTable.get(key) ?? null;
      },
    },
    // EOBD/PPR — `AuthService.verifyAccessKey` is called by ScopeGuard's Path 1
    // (session-token) right after entity validation. Returning null here means
    // "no Platos access key configured for this scope, skip the secondary
    // origin gate" — same shape the production code expects when a self-host
    // has not provisioned an X-Platos-Api-Key. Tests that need a key in
    // place can override this stub.
    platosAccessKey: {
      findFirst: async () => null,
    },
  } as any;
}

function makeAuthService(entityTable: Map<string, { serviceSecret: string }>): AuthService {
  const prisma = makePrismaStub(entityTable);
  const redis = {} as any; // ScopeGuard path doesn't touch redis
  return new AuthService(prisma, redis);
}

function mintEntityToken(
  secret: string,
  claims: Record<string, unknown>,
): string {
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
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
});

describe("ScopeGuard — Path 1 session token", () => {
  let entityTable: Map<string, { serviceSecret: string }>;
  const ENTITY_SECRET = "sekret-32-bytes-aaaaaaaaaaaaaaaaa";
  const scope = {
    organizationId: "org_A",
    projectId: "proj_A",
    environmentId: "env_A",
    userId: "user_A",
    entityId: "ent_A",
  };

  beforeEach(() => {
    entityTable = new Map();
    entityTable.set(
      `${scope.organizationId}:${scope.projectId}:${scope.entityId}`,
      { serviceSecret: ENTITY_SECRET },
    );
  });

  it("accepts a valid entity-signed session token", async () => {
    const auth = makeAuthService(entityTable);
    const guard = new ScopeGuard(auth);
    const token = mintEntityToken(ENTITY_SECRET, {
      ...scope,
      iss: "entity",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const ctx = mockExecutionContext({
      "x-platos-session-token": token,
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = (ctx.switchToHttp().getRequest() as any);
    expect(req.scope.organizationId).toBe(scope.organizationId);
    expect(req.scope.entityId).toBe(scope.entityId);
  });

  it("rejects an HMAC-tampered token (signature mismatch)", async () => {
    const auth = makeAuthService(entityTable);
    const guard = new ScopeGuard(auth);
    const good = mintEntityToken(ENTITY_SECRET, {
      ...scope,
      iss: "entity",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    // Tamper: swap last signature char. Guarantees HMAC mismatch.
    const parts = good.split(".");
    const sig = parts[1];
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    const tampered = `${parts[0]}.${flipped}`;

    const ctx = mockExecutionContext({ "x-platos-session-token": tampered });
    // Guard falls through to direct headers path when token fails — no
    // direct headers provided, so the final UnauthorizedException fires.
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects an expired token", async () => {
    const auth = makeAuthService(entityTable);
    const guard = new ScopeGuard(auth);
    const token = mintEntityToken(ENTITY_SECRET, {
      ...scope,
      iss: "entity",
      exp: Math.floor(Date.now() / 1000) - 10, // 10s in the past
    });
    const ctx = mockExecutionContext({ "x-platos-session-token": token });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects when the claimed entity doesn't exist (wrong-entity)", async () => {
    const auth = makeAuthService(entityTable);
    const guard = new ScopeGuard(auth);
    const token = mintEntityToken(ENTITY_SECRET, {
      ...scope,
      entityId: "nonexistent-entity",
      iss: "entity",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const ctx = mockExecutionContext({ "x-platos-session-token": token });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a malformed token (not dot-separated)", async () => {
    const auth = makeAuthService(entityTable);
    const guard = new ScopeGuard(auth);
    const ctx = mockExecutionContext({ "x-platos-session-token": "not-a-real-token" });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
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
