import { Injectable } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import {
  type ControlDatabaseClient,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";

const TOKEN_PREFIX = "plt_ent_";
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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

  private async auditScope(entityId: string): Promise<{
    organizationId: string;
    projectId: string;
    environmentId: string;
  }> {
    const entity = await this.prisma.entity.findUnique({
      where: { id: entityId },
      select: {
        project: {
          select: {
            id: true,
            organizationId: true,
            environments: {
              where: { archivedAt: null },
              select: { id: true },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    });
    const environmentId = entity?.project.environments[0]?.id;
    if (!entity || !environmentId) {
      throw new Error("Entity is not attached to an active environment");
    }
    return {
      organizationId: entity.project.organizationId,
      projectId: entity.project.id,
      environmentId,
    };
  }

  private auditData(
    scope: Awaited<ReturnType<McpBearerTokenService["auditScope"]>>,
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
      },
      source: "entity_mcp",
    } as const;
  }

  /** Generate a new PAT for an entity. Returns the raw token (shown once). */
  async generate(
    entityPk: string,
    label: string,
    createdBy: string,
    options: { scopes?: string[]; expiresAt?: Date; mcpUserId?: string } = {}
  ): Promise<{ id: string; raw: string; mcpUserId: string }> {
    const raw = `${TOKEN_PREFIX}${randomBytes(48).toString("base64url")}`;
    const tokenHash = McpBearerTokenService.hashToken(raw);
    const id = randomUUID();
    const mcpUserId = options.mcpUserId ?? `mcp:pat:${id}`;
    const scope = await this.auditScope(entityPk);
    const expiresAt = options.expiresAt ?? new Date(Date.now() + DEFAULT_TTL_MS);
    if (expiresAt.getTime() <= Date.now()) {
      throw new Error("expiresAt must be in the future");
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.mcpBearerToken.create({
        data: {
          id,
          entityId: entityPk,
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
    mcpUserId: string;
    scopes: string[];
  } | null> {
    if (!raw.startsWith(TOKEN_PREFIX)) return null;
    const tokenHash = McpBearerTokenService.hashToken(raw);
    const row = await this.prisma.mcpBearerToken.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (!row || !constantTimeHexEqual(row.tokenHash, tokenHash)) return null;
    const scope = await this.auditScope(row.entityId);
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
    return { id: row.id, entityPk: row.entityId, mcpUserId: row.mcpUserId, scopes: row.scopes };
  }

  /** List tokens for an entity (hashes not returned). */
  async list(entityPk: string): Promise<
    Array<{
      id: string;
      label: string;
      mcpUserId: string;
      scopes: string[];
      createdAt: Date;
      lastUsedAt: Date | null;
      expiresAt: Date | null;
      revokedAt: Date | null;
    }>
  > {
    return this.prisma.mcpBearerToken.findMany({
      where: { entityId: entityPk },
      select: {
        id: true,
        label: true,
        mcpUserId: true,
        scopes: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Revoke a PAT by id, scoped to entityPk. */
  async revoke(id: string, entityPk: string, revokedBy?: string): Promise<boolean> {
    const existing = await this.prisma.mcpBearerToken.findFirst({
      where: { id, entityId: entityPk },
      select: { id: true, revokedAt: true },
    });
    if (!existing) return false;
    if (existing.revokedAt) return true;
    const scope = await this.auditScope(entityPk);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.mcpBearerToken.updateMany({
        where: { id, entityId: entityPk, revokedAt: null },
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
