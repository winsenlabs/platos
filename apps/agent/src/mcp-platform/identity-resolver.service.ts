import { Injectable, Inject } from "@nestjs/common";
import { McpIdentityStore, type McpIdentityReader } from "./mcp-identity.store";
import { McpBearerTokenService } from "./mcp-bearer-token.service";
import type { Request } from "express";

export interface McpIdentityResult {
  mcpUserId: string;
  environmentId: string;
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
    @Inject(McpIdentityStore) private readonly store: McpIdentityReader,
    private readonly bearerTokenService: McpBearerTokenService,
  ) {}

  async resolve(
    req: Request,
    entityPk: string,
  ): Promise<McpIdentityResult | McpIdentityRejectReason> {
    const authHeader = req.headers["authorization"] as string | undefined;
    const entityConfig = await this.store.readMcpSurface(entityPk);

    if (!entityConfig?.enabled) {
      return { error: "MCP not enabled for this entity", status: 403 };
    }

    const identityMode = entityConfig.identityMode ?? "anonymous";
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
        environmentId: token.environmentId,
        identityMode: "bearer",
        metadata: {
          tokenId: token.id,
          scopes: token.scopes,
          environmentId: token.environmentId,
        },
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
      const environment = await this.resolveAnonymousEnvironment(entityPk, req);
      if ("error" in environment) return environment;
      // Mint or retrieve anonymous session in the explicitly resolved environment.
      const result = await this.getOrCreateAnonSession(
        entityPk,
        environment.environmentId,
        req,
      );
      return {
        mcpUserId: result.mcpUserId,
        environmentId: environment.environmentId,
        identityMode: "anonymous",
        metadata: {
          sessionId: result.id,
          environmentId: environment.environmentId,
        },
      };
    }

    return { error: "Unrecognized authentication scheme", status: 401 };
  }

  private async getOrCreateAnonSession(
    entityPk: string,
    environmentId: string,
    req: Request,
  ): Promise<{ id: string; mcpUserId: string }> {
    // Check for existing anon session cookie/header
    const existingId = req.headers["x-mcp-anon-session"] as string | undefined;
    if (existingId) {
      const existing = await this.store.findLiveAnonymousSession(entityPk, environmentId, existingId);
      if (existing) {
        void this.store.touchAnonymousSession(existing.id);
        return existing;
      }
    }

    // Create new anon session. `identity-access` owns `McpAnonymousSession` and
    // its contract publishes NO mint — deliberately, per its own banner — so
    // this is a call site WIN-268 P2 stopped at rather than routed. See
    // `mcp-identity.store.ts`.
    return this.store.createAnonymousSession(entityPk, environmentId, {
      firstSeenIp:
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
        ?? (req.socket.remoteAddress ?? null),
      userAgent: req.headers["user-agent"] ?? null,
    });
  }

  private async resolveAnonymousEnvironment(
    entityPk: string,
    req: Request,
  ): Promise<{ environmentId: string } | McpIdentityRejectReason> {
    const queryValue = (req.query as Record<string, unknown> | undefined)?.environmentId;
    if (Array.isArray(queryValue)) {
      return { error: "environmentId must be a single canonical id", status: 400 };
    }
    const requested = typeof queryValue === "string" && queryValue.trim()
      ? queryValue.trim()
      : undefined;
    if (!requested) {
      return { error: "environmentId is required for anonymous MCP authentication", status: 400 };
    }
    const environmentId = await this.store.findActiveEnvironmentForEntity(entityPk, requested);
    return environmentId
      ? { environmentId }
      : { error: "environmentId is not active for this entity", status: 403 };
  }
}
