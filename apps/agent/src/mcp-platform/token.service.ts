import { Inject, Injectable } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";

/**
 * Opaque MCP control-plane tokens. Raw values use the established `plt_mcp_`
 * prefix and are returned once; only SHA-256 digests are persisted.
 */
export type PlatosMCPTokenTier = "scope" | "admin";

export interface MintTokenInput {
  scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId" | "userId">;
  name: string;
  permissions: string[];
  /** Lifetime in seconds. Defaults to 90 days and must be positive. */
  ttlSeconds?: number;
  /** Admin-tier tokens are restricted to organization owners/admins. */
  tier?: PlatosMCPTokenTier;
}

export interface MintedToken {
  id: string;
  token: string;
  name: string;
  permissions: string[];
  tier: PlatosMCPTokenTier;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface VerifiedToken {
  id: string;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  };
  permissions: string[];
  mintedByUserId: string;
  expiresAt: Date | null;
  tier: PlatosMCPTokenTier;
  /** Opaque persisted credential reference used to revalidate long-lived
   * transports without retaining the raw bearer in memory. */
  credential?: { kind: "platform"; tokenId: string } | { kind: "oauth"; tokenHash: string };
}

const DEFAULT_TTL_SECONDS = 90 * 24 * 3600;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value as number)) : fallback;
}
const TOKEN_PREFIX = "plt_mcp_";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export class AdminMintForbiddenError extends Error {
  constructor(userId: string, organizationId: string) {
    super(
      `user ${userId} is not an owner or admin of organization ${organizationId} — admin-tier MCP tokens are reserved for organization administrators`
    );
    this.name = "AdminMintForbiddenError";
  }
}

function normalizeTier(raw: unknown): PlatosMCPTokenTier {
  return raw === "admin" ? "admin" : "scope";
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

@Injectable()
export class PlatosMCPTokenService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient) {}

  private hashToken(raw: string): string {
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Load canonical ancestry from the Environment row. Request tuples are used
   * only as assertions and never become persisted or returned authority.
   */
  private async resolveScope(scope: ScopeTuple): Promise<ScopeTuple | null> {
    const environment = await this.prisma.environment.findUnique({
      where: { id: scope.environmentId },
      select: {
        id: true,
        project: { select: { id: true, organizationId: true } },
      },
    });
    if (
      !environment ||
      environment.project.id !== scope.projectId ||
      environment.project.organizationId !== scope.organizationId
    ) {
      return null;
    }
    return {
      organizationId: environment.project.organizationId,
      projectId: environment.project.id,
      environmentId: environment.id,
    };
  }

  /** Generate a token and return its raw bearer once. */
  async mint(input: MintTokenInput): Promise<MintedToken> {
    if (!input.name || input.name.length < 1 || input.name.length > 80) {
      throw new Error("token name must be 1–80 chars");
    }
    if (!Array.isArray(input.permissions) || input.permissions.length === 0) {
      throw new Error("permissions must be a non-empty array");
    }

    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error("ttlSeconds must be a positive number");
    }

    const canonical = await this.resolveScope(input.scope);
    if (!canonical) throw new Error("Environment not found in scope");

    const tier = normalizeTier(input.tier);
    if (tier === "admin") {
      const membership = await this.prisma.organizationMembership.findFirst({
        where: {
          organizationId: canonical.organizationId,
          userId: input.scope.userId,
          deactivatedAt: null,
          role: { in: ["OWNER", "ADMIN"] },
        },
        select: { id: true },
      });
      if (!membership) {
        throw new AdminMintForbiddenError(input.scope.userId, canonical.organizationId);
      }
    }

    const raw = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    const tokenHash = this.hashToken(raw);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const row = await this.prisma.mcpToken.create({
      data: {
        environmentId: canonical.environmentId,
        mintedByUserId: input.scope.userId,
        name: input.name,
        tokenHash,
        permissions: input.permissions,
        tier,
        expiresAt,
      },
      select: {
        id: true,
        name: true,
        permissions: true,
        tier: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    return {
      id: row.id,
      name: row.name,
      permissions: row.permissions,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      tier: normalizeTier(row.tier),
      token: raw,
    };
  }

  /** Verify a bearer and derive its scope solely from persisted ancestry. */
  async verify(raw: string | undefined | null): Promise<VerifiedToken | null> {
    if (!raw || typeof raw !== "string" || !raw.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    const tokenHash = this.hashToken(raw);
    return this.verifyPersisted({ tokenHash }, tokenHash);
  }

  /** Revalidate an established SSE session without storing its raw bearer. */
  async verifyById(id: string): Promise<VerifiedToken | null> {
    if (!id) return null;
    return this.verifyPersisted({ id });
  }

  private async verifyPersisted(
    where: { id: string } | { tokenHash: string },
    expectedHash?: string
  ): Promise<VerifiedToken | null> {
    const row = await this.prisma.mcpToken.findUnique({
      where,
      select: {
        id: true,
        tokenHash: true,
        permissions: true,
        mintedByUserId: true,
        tier: true,
        expiresAt: true,
        revokedAt: true,
        environment: {
          select: {
            id: true,
            project: { select: { id: true, organizationId: true } },
          },
        },
      },
    });
    if (
      !row ||
      (expectedHash && !constantTimeHexEqual(row.tokenHash, expectedHash)) ||
      row.revokedAt
    )
      return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

    const updated = await this.prisma.mcpToken.updateMany({
      where: {
        id: row.id,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: { lastUsedAt: new Date() },
    });
    if (updated.count !== 1) return null;

    return {
      id: row.id,
      scope: {
        organizationId: row.environment.project.organizationId,
        projectId: row.environment.project.id,
        environmentId: row.environment.id,
      },
      permissions: row.permissions,
      mintedByUserId: row.mintedByUserId,
      expiresAt: row.expiresAt,
      tier: normalizeTier(row.tier),
      credential: { kind: "platform", tokenId: row.id },
    };
  }

  /** List redacted token metadata for a canonically resolved Environment. */
  async list(
    scope: ScopeTuple,
    options: { limit?: number; offset?: number } = {}
  ): Promise<{
    tokens: Array<{
      id: string;
      name: string;
      permissions: string[];
      tier: PlatosMCPTokenTier;
      mintedByUserId: string;
      expiresAt: Date | null;
      lastUsedAt: Date | null;
      revokedAt: Date | null;
      createdAt: Date;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    const canonical = await this.resolveScope(scope);
    const limit = boundedInteger(options.limit, 50, 1, 100);
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    if (!canonical) return { tokens: [], total: 0, limit, offset };
    const where = { environmentId: canonical.environmentId };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.mcpToken.count({ where }),
      this.prisma.mcpToken.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: offset,
        take: limit,
        select: {
          id: true,
          name: true,
          permissions: true,
          tier: true,
          mintedByUserId: true,
          expiresAt: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
        },
      }),
    ]);
    const tokens = rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      permissions: row.permissions,
      tier: normalizeTier(row.tier),
      mintedByUserId: row.mintedByUserId,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    }));
    return { tokens, total, limit, offset };
  }

  /** Idempotently revoke a token in the caller's canonical Environment. */
  async revoke(
    id: string,
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId" | "userId">
  ): Promise<boolean> {
    const canonical = await this.resolveScope(scope);
    if (!canonical) return false;
    const existing = await this.prisma.mcpToken.findFirst({
      where: { id, environmentId: canonical.environmentId },
      select: { id: true, revokedAt: true },
    });
    if (!existing) return false;
    if (existing.revokedAt) return true;

    await this.prisma.mcpToken.updateMany({
      where: { id, environmentId: canonical.environmentId, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: scope.userId },
    });
    return true;
  }

  /** Check whether the token's permissions allow the given tool name. */
  static allows(permissions: string[], toolName: string): boolean {
    for (const pattern of permissions) {
      if (pattern === "*" || pattern === toolName) return true;
      if (pattern.endsWith(".*")) {
        const prefix = pattern.slice(0, -2);
        if (toolName.startsWith(`${prefix}.`) || toolName === prefix) return true;
      }
    }
    return false;
  }
}
