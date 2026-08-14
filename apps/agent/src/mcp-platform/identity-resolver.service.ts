import { Injectable, Inject } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { McpBearerTokenService } from "./mcp-bearer-token.service";
import type { Request } from "express";
import { randomUUID } from "crypto";

export interface McpIdentityResult {
  mcpUserId: string;
  identityMode: "anonymous" | "oidc" | "bearer";
  metadata: Record<string, unknown>;
}

export interface McpIdentityRejectReason {
  error: string;
  status: number;
}

/**
 * PIFSP-22 — MCP identity resolver. Routes incoming requests to the
 * correct identity validator based on token type and entity config.
 *
 * Resolution order:
 *   1. Authorization: Bearer plt_ent_... → Bearer PAT path
 *   2. Authorization: Bearer <oauth-token> → OAuth access token path
 *   3. No auth header → Anonymous path (if entity allows anonymous)
 */
@Injectable()
export class McpIdentityResolverService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly bearerTokenService: McpBearerTokenService,
  ) {}

  async resolve(
    req: Request,
    entityPk: string,
  ): Promise<McpIdentityResult | McpIdentityRejectReason> {
    const authHeader = req.headers["authorization"] as string | undefined;
    const entityConfig = await this.prisma.platosEntityMcpConfig.findFirst({
      where: { entityPk },
      select: { identityMode: true, enabled: true },
    });

    if (!entityConfig?.enabled) {
      return { error: "MCP not enabled for this entity", status: 403 };
    }

    const identityMode = (entityConfig.identityMode as string) ?? "anonymous";
    const allowedModes = identityMode.split("+");

    // 1. Bearer PAT (plt_ent_ prefix)
    if (authHeader?.startsWith("Bearer plt_ent_")) {
      if (!allowedModes.some((m) => m === "bearer")) {
        return { error: "Bearer tokens not enabled for this entity", status: 403 };
      }
      const raw = authHeader.slice("Bearer ".length);
      const token = await this.bearerTokenService.validate(raw);
      if (!token) {
        return { error: "Invalid or revoked bearer token", status: 401 };
      }
      if (token.entityPk !== entityPk) {
        return { error: "Token entity mismatch", status: 403 };
      }
      return {
        mcpUserId: token.mcpUserId,
        identityMode: "bearer",
        metadata: { tokenId: token.id, scopes: token.scopes },
      };
    }

    // 2. OAuth access token (handled upstream by mcp-entity.controller.ts)
    // If the controller already validated and set mcpUserId on the request, use it.
    if ((req as any).mcpIdentity) {
      return (req as any).mcpIdentity as McpIdentityResult;
    }

    // 3. Anonymous (no auth header or unrecognized token)
    if (!authHeader) {
      if (!allowedModes.some((m) => m === "anonymous")) {
        return { error: "This entity requires authentication", status: 401 };
      }
      // Mint or retrieve anonymous session
      const result = await this.getOrCreateAnonSession(entityPk, req);
      return {
        mcpUserId: result.mcpUserId,
        identityMode: "anonymous",
        metadata: { sessionId: result.id },
      };
    }

    return { error: "Unrecognized authentication scheme", status: 401 };
  }

  private async getOrCreateAnonSession(
    entityPk: string,
    req: Request,
  ): Promise<{ id: string; mcpUserId: string }> {
    // Check for existing anon session cookie/header
    const existingId = req.headers["x-mcp-anon-session"] as string | undefined;
    if (existingId) {
      const existing = await this.prisma.platosMcpAnonSession.findFirst({
        where: { mcpUserId: existingId, entityPk, revokedAt: null },
        select: { id: true, mcpUserId: true },
      });
      if (existing) {
        this.prisma.platosMcpAnonSession.update({
          where: { id: existing.id },
          data: { lastUsedAt: new Date() },
        }).catch(() => undefined);
        return existing;
      }
    }

    // Create new anon session
    const mcpUserId = `mcp:anon:${randomUUID().replace(/-/g, "")}`;
    const session = await this.prisma.platosMcpAnonSession.create({
      data: {
        entityPk,
        mcpUserId,
        firstSeenIp: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? (req.socket.remoteAddress ?? null),
        userAgent: req.headers["user-agent"] ?? null,
      },
      select: { id: true, mcpUserId: true },
    });
    return session;
  }
}
