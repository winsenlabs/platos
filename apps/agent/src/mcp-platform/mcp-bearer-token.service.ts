import { Injectable } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import {
  type ControlDatabaseClient,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";

const TOKEN_PREFIX = "plt_ent_";
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value)
    ? Math.max(minimum, Math.min(maximum, value as number))
    : fallback;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * PIFSP-22 — Bearer PAT (Personal Access Token) for service-to-service
 * or CI/CD MCP access. Tokens use the prefix `plt_ent_` and are stored as
 * sha256 hashes (raw value shown once on generation).
 */
@Injectable()
export class McpBearerTokenService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
  ) {}

  private static hashToken(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
  }

  private async resolveScope(entityId: string, environmentId: string): Promise<{
    organizationId: string;
    projectId: string;
    environmentId: string;
  } | null> {
    const entity = await this.prisma.entity.findFirst({
      where: {
        id: entityId,
        project: {
          environments: {
            some: { id: environmentId, archivedAt: null },
          },
        },
      },
      select: {
        project: {
          select: {
            id: true,
            organizationId: true,
          },
        },
      },
    });
    if (!entity) return null;
    return {
      organizationId: entity.project.organizationId,
      projectId: entity.project.id,
      environmentId,
    };
  }

  private auditData(
    scope: NonNullable<Awaited<ReturnType<McpBearerTokenService["resolveScope"]>>>,
    tokenId: string,
    action: "mint" | "use" | "revoke",
    actorUserId?: string,
  ) {
    return {
      environmentId: scope.environmentId,
      actorUserId: actorUserId ?? null,
      action: `mcp_bearer.${action}`,
      subjectType: "McpBearerToken",
      subjectId: tokenId,
      after: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      source: "entity_mcp",
    } as const;
  }

  /** Generate a new PAT for an entity. Returns the raw token (shown once). */
  async generate(
    entityPk: string,
    environmentId: string,
    label: string,
    createdBy: string,
    options: { scopes?: string[]; expiresAt?: Date; mcpUserId?: string } = {}
  ): Promise<{ id: string; raw: string; mcpUserId: string }> {
    const raw = `${TOKEN_PREFIX}${randomBytes(48).toString("base64url")}`;
    const tokenHash = McpBearerTokenService.hashToken(raw);
    const id = randomUUID();
    const mcpUserId = options.mcpUserId ?? `mcp:pat:${id}`;
    const scope = await this.resolveScope(entityPk, environmentId);
    if (!scope) {
      throw new Error("Entity and environment do not share canonical project ancestry");
    }
    const expiresAt = options.expiresAt ?? new Date(Date.now() + DEFAULT_TTL_MS);
    if (expiresAt.getTime() <= Date.now()) {
      throw new Error("expiresAt must be in the future");
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.mcpBearerToken.create({
        data: {
          id,
          entityId: entityPk,
          environmentId,
          tokenHash,
          label,
          mcpUserId,
          scopes: options.scopes ?? ["mcp:tools"],
          createdByUserId: createdBy,
          expiresAt,
        },
      });
      await tx.adminAudit.create({
        data: this.auditData(scope, id, "mint", createdBy),
      });
    });
    return { id, raw, mcpUserId };
  }

  /** Validate a raw PAT. Returns the token record or null if invalid. */
  async validate(raw: string): Promise<{
    id: string;
    entityPk: string;
    environmentId: string;
    mcpUserId: string;
    scopes: string[];
  } | null> {
    if (!raw.startsWith(TOKEN_PREFIX)) return null;
    const tokenHash = McpBearerTokenService.hashToken(raw);
    return this.validateHash(tokenHash);
  }

  /** Revalidate an SSE session without retaining the raw bearer in Redis. */
  async validateHash(tokenHash: string): Promise<{
    id: string;
    entityPk: string;
    environmentId: string;
    mcpUserId: string;
    scopes: string[];
  } | null> {
    const row = await this.prisma.mcpBearerToken.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (!row || !constantTimeHexEqual(row.tokenHash, tokenHash)) return null;
    const scope = await this.resolveScope(row.entityId, row.environmentId);
    if (!scope) return null;
    const recorded = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.mcpBearerToken.updateMany({
        where: {
          id: row.id,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        data: { lastUsedAt: new Date() },
      });
      if (updated.count !== 1) return false;
      await tx.adminAudit.create({
        data: this.auditData(scope, row.id, "use"),
      });
      return true;
    });
    if (!recorded) return null;
    return {
      id: row.id,
      entityPk: row.entityId,
      environmentId: row.environmentId,
      mcpUserId: row.mcpUserId,
      scopes: row.scopes,
    };
  }

  /** List tokens for an entity (hashes not returned). */
  async list(
    entityPk: string,
    environmentId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<
    {
      tokens: Array<{
      id: string;
      environmentId: string;
      label: string;
      mcpUserId: string;
      scopes: string[];
      createdAt: Date;
      lastUsedAt: Date | null;
      expiresAt: Date | null;
      revokedAt: Date | null;
      }>;
      total: number;
      limit: number;
      offset: number;
    }
  > {
    const scope = await this.resolveScope(entityPk, environmentId);
    if (!scope) {
      throw new Error("Entity and environment do not share canonical project ancestry");
    }
    const limit = boundedInteger(options.limit, 50, 1, 100);
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const where = { entityId: entityPk, environmentId };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.mcpBearerToken.count({ where }),
      this.prisma.mcpBearerToken.findMany({
        where,
        select: {
          id: true,
          environmentId: true,
          label: true,
          mcpUserId: true,
          scopes: true,
          createdAt: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: offset,
        take: limit,
      }),
    ]);
    return {
      tokens: rows,
      total,
      limit,
      offset,
    };
  }

  /** Revoke a PAT by id, scoped to entityPk. */
  async revoke(
    id: string,
    entityPk: string,
    environmentId: string,
    revokedBy?: string,
  ): Promise<boolean> {
    const existing = await this.prisma.mcpBearerToken.findFirst({
      where: { id, entityId: entityPk, environmentId },
      select: { id: true, revokedAt: true },
    });
    if (!existing) return false;
    if (existing.revokedAt) return true;
    const scope = await this.resolveScope(entityPk, environmentId);
    if (!scope) return false;
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.mcpBearerToken.updateMany({
        where: { id, entityId: entityPk, environmentId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (updated.count === 0) return;
      await tx.adminAudit.create({
        data: this.auditData(scope, id, "revoke", revokedBy),
      });
    });
    return true;
  }
}
