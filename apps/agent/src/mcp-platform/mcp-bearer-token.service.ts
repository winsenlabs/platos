import { Injectable } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
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
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: any) {}

  private static hashToken(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
  }

  private async auditScope(entityPk: string): Promise<{
    organizationId: string | null;
    projectId: string | null;
  }> {
    const entity = await this.prisma.platosConnectedEntity.findUnique({
      where: { id: entityPk },
      select: { organizationId: true, projectId: true },
    });
    return {
      organizationId: entity?.organizationId ?? null,
      projectId: entity?.projectId ?? null,
    };
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
    await this.prisma.$transaction(async (tx: any) => {
      await tx.platosMcpBearerToken.create({
        data: {
          id,
          entityPk,
          tokenHash,
          label,
          mcpUserId,
          scopes: options.scopes ?? ["mcp:tools"],
          createdBy,
          expiresAt,
        },
      });
      await tx.platosCredentialAudit.create({
        data: {
          family: "entity_mcp",
          credentialId: id,
          action: "mint",
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          actorUserId: createdBy,
        },
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
    const row = await this.prisma.platosMcpBearerToken.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (!row || !constantTimeHexEqual(row.tokenHash, tokenHash)) return null;
    const scope = await this.auditScope(row.entityPk);
    const recorded = await this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.platosMcpBearerToken.updateMany({
        where: {
          id: row.id,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        data: { lastUsedAt: new Date() },
      });
      if (updated.count !== 1) return false;
      await tx.platosCredentialAudit.create({
        data: {
          family: "entity_mcp",
          credentialId: row.id,
          action: "use",
          organizationId: scope.organizationId,
          projectId: scope.projectId,
        },
      });
      return true;
    });
    if (!recorded) return null;
    return { id: row.id, entityPk: row.entityPk, mcpUserId: row.mcpUserId, scopes: row.scopes };
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
    return this.prisma.platosMcpBearerToken.findMany({
      where: { entityPk },
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
    const existing = await this.prisma.platosMcpBearerToken.findFirst({
      where: { id, entityPk },
      select: { id: true, revokedAt: true },
    });
    if (!existing) return false;
    if (existing.revokedAt) return true;
    const scope = await this.auditScope(entityPk);
    await this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.platosMcpBearerToken.updateMany({
        where: { id, entityPk, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (updated.count === 0) return;
      await tx.platosCredentialAudit.create({
        data: {
          family: "entity_mcp",
          credentialId: id,
          action: "revoke",
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          actorUserId: revokedBy ?? null,
        },
      });
    });
    return true;
  }
}
