import { Injectable } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { createHash, randomBytes } from "crypto";

/**
 * PIFSP-22 — Bearer PAT (Personal Access Token) for service-to-service
 * or CI/CD MCP access. Tokens use the prefix `pmt_` and are stored as
 * sha256 hashes (raw value shown once on generation).
 */
@Injectable()
export class McpBearerTokenService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: any) {}

  private static hashToken(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
  }

  /** Generate a new PAT for an entity. Returns the raw token (shown once). */
  async generate(
    entityPk: string,
    label: string,
    createdBy: string,
    options: { scopes?: string[]; expiresAt?: Date; mcpUserId?: string } = {},
  ): Promise<{ id: string; raw: string; mcpUserId: string }> {
    const raw = `pmt_${randomBytes(48).toString("base64url")}`;
    const tokenHash = McpBearerTokenService.hashToken(raw);
    const record = await this.prisma.platosMcpBearerToken.create({
      data: {
        entityPk,
        tokenHash,
        label,
        mcpUserId: options.mcpUserId ?? `mcp:pat:${Date.now()}`,
        scopes: options.scopes ?? ["mcp:tools"],
        createdBy,
        expiresAt: options.expiresAt ?? null,
      },
    });
    // Write the mcpUserId back with the record id so it's deterministic
    const finalMcpUserId = options.mcpUserId ?? `mcp:pat:${record.id}`;
    await this.prisma.platosMcpBearerToken.update({
      where: { id: record.id },
      data: { mcpUserId: finalMcpUserId },
    });
    return { id: record.id, raw, mcpUserId: finalMcpUserId };
  }

  /** Validate a raw PAT. Returns the token record or null if invalid. */
  async validate(raw: string): Promise<{
    id: string;
    entityPk: string;
    mcpUserId: string;
    scopes: string[];
  } | null> {
    const tokenHash = McpBearerTokenService.hashToken(raw);
    const row = await this.prisma.platosMcpBearerToken.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (!row) return null;
    // Update lastUsedAt (fire-and-forget)
    this.prisma.platosMcpBearerToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return { id: row.id, entityPk: row.entityPk, mcpUserId: row.mcpUserId, scopes: row.scopes };
  }

  /** List tokens for an entity (hashes not returned). */
  async list(entityPk: string): Promise<Array<{
    id: string; label: string; mcpUserId: string; scopes: string[];
    createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null;
  }>> {
    return this.prisma.platosMcpBearerToken.findMany({
      where: { entityPk },
      select: { id: true, label: true, mcpUserId: true, scopes: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Revoke a PAT by id, scoped to entityPk. */
  async revoke(id: string, entityPk: string): Promise<boolean> {
    const result = await this.prisma.platosMcpBearerToken.updateMany({
      where: { id, entityPk, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }
}
