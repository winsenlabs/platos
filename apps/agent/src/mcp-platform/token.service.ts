import { Inject, Injectable } from "@nestjs/common";
import {
  AuthorizationScopeKind,
  OrganizationRole,
  ProjectRole,
  TokenFamily,
  TokenLifecycleAction,
  TokenLifecycleOutcome,
} from "@platos/database";
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
  /** Admin-tier tokens use the same Project ADMIN / Organization admin gate as scope-tier mint. */
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
}

const DEFAULT_TTL_SECONDS = 90 * 24 * 3600;
const TOKEN_PREFIX = "plt_mcp_";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;
type AuthorizedScope = ScopeTuple & {
  organizationRole: OrganizationRole;
  projectRole: ProjectRole | null;
};

export class MCPTokenForbiddenError extends Error {
  constructor() {
    super("MCP token access is outside the user's active project membership");
    this.name = "MCPTokenForbiddenError";
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
  private async authorizeScope(
    scope: ScopeTuple & Pick<RequestScope, "userId">,
    access: "read" | "mutate",
  ): Promise<AuthorizedScope> {
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
      throw new MCPTokenForbiddenError();
    }

    const organizationMembership = await this.prisma.organizationMembership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: environment.project.organizationId,
          userId: scope.userId,
        },
      },
      select: { id: true, role: true, deactivatedAt: true },
    });
    if (!organizationMembership || organizationMembership.deactivatedAt) {
      throw new MCPTokenForbiddenError();
    }
    const projectMembership = await this.prisma.projectMembership.findUnique({
      where: {
        projectId_organizationMembershipId: {
          projectId: environment.project.id,
          organizationMembershipId: organizationMembership.id,
        },
      },
      select: { role: true },
    });
    const organizationAdmin =
      organizationMembership.role === OrganizationRole.OWNER ||
      organizationMembership.role === OrganizationRole.ADMIN;
    if (access === "read" && !projectMembership) throw new MCPTokenForbiddenError();
    if (
      access === "mutate" &&
      !organizationAdmin &&
      projectMembership?.role !== ProjectRole.ADMIN
    ) {
      throw new MCPTokenForbiddenError();
    }
    return {
      organizationId: environment.project.organizationId,
      projectId: environment.project.id,
      environmentId: environment.id,
      organizationRole: organizationMembership.role,
      projectRole: projectMembership?.role ?? null,
    };
  }

  async authorizeMetadataAccess(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId" | "userId">,
  ): Promise<void> {
    await this.authorizeScope(scope, "read");
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

    const canonical = await this.authorizeScope(input.scope, "mutate");

    const tier = normalizeTier(input.tier);

    const raw = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    const tokenHash = this.hashToken(raw);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.mcpToken.create({
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
      await tx.tokenLifecycleAudit.create({
        data: {
          family: TokenFamily.MCP_TOKEN,
          mcpTokenId: created.id,
          scopeKind: AuthorizationScopeKind.ENVIRONMENT,
          environmentId: canonical.environmentId,
          actorUserId: input.scope.userId,
          action: TokenLifecycleAction.MINT,
          outcome: TokenLifecycleOutcome.SUCCESS,
        },
      });
      return created;
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
    const row = await this.prisma.mcpToken.findUnique({
      where: { tokenHash },
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
    if (!row || !constantTimeHexEqual(row.tokenHash, tokenHash) || row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

    const recorded = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.mcpToken.updateMany({
        where: {
          id: row.id,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        data: { lastUsedAt: new Date() },
      });
      if (updated.count !== 1) return false;
      await tx.tokenLifecycleAudit.create({
        data: {
          family: TokenFamily.MCP_TOKEN,
          mcpTokenId: row.id,
          scopeKind: AuthorizationScopeKind.ENVIRONMENT,
          environmentId: row.environment.id,
          actorUserId: row.mintedByUserId,
          action: TokenLifecycleAction.USE,
          outcome: TokenLifecycleOutcome.SUCCESS,
        },
      });
      return true;
    });
    if (!recorded) return null;

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
    };
  }

  /** List redacted token metadata for a canonically resolved Environment. */
  async list(scope: ScopeTuple & Pick<RequestScope, "userId">): Promise<
    Array<{
      id: string;
      name: string;
      permissions: string[];
      tier: PlatosMCPTokenTier;
      mintedByUserId: string;
      expiresAt: Date | null;
      lastUsedAt: Date | null;
      revokedAt: Date | null;
      createdAt: Date;
    }>
  > {
    const canonical = await this.authorizeScope(scope, "read");
    const rows = await this.prisma.mcpToken.findMany({
      where: { environmentId: canonical.environmentId },
      orderBy: { createdAt: "desc" },
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
    });
    return rows.map((row: any) => ({
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
  }

  /** Idempotently revoke a token in the caller's canonical Environment. */
  async revoke(
    id: string,
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId" | "userId">,
  ): Promise<boolean> {
    const canonical = await this.authorizeScope(scope, "mutate");
    const existing = await this.prisma.mcpToken.findFirst({
      where: { id, environmentId: canonical.environmentId },
      select: { id: true, revokedAt: true },
    });
    if (!existing) return false;
    if (existing.revokedAt) return true;

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.mcpToken.updateMany({
        where: { id, environmentId: canonical.environmentId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: scope.userId },
      });
      if (updated.count !== 1) return;
      await tx.tokenLifecycleAudit.create({
        data: {
          family: TokenFamily.MCP_TOKEN,
          mcpTokenId: id,
          scopeKind: AuthorizationScopeKind.ENVIRONMENT,
          environmentId: canonical.environmentId,
          actorUserId: scope.userId,
          action: TokenLifecycleAction.REVOKE,
          outcome: TokenLifecycleOutcome.SUCCESS,
        },
      });
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
