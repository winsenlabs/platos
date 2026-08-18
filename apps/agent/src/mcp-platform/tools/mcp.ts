/**
 * Theme MCPF-W3 — MCP-specific token + client management tools.
 *
 *   • `mcp.list_tokens`  — list per-entity bearer PATs (`plt_ent_*`) used for
 *                          service-to-service MCP access. Aggregated across
 *                          every entity in scope.
 *   • `mcp.list_clients` — list MCP-issuing OAuth clients (PIFSP-21 entity-
 *                          scoped DCR clients) that have minted at least one
 *                          access token reaching this org.
 *
 * Both tools return metadata only — token hashes are never returned. The
 * mint-time plaintext (`entities.generate_mcp_token`) is the only path that
 * exposes the raw bearer.
 */

import type { McpBearerTokenService } from "../mcp-bearer-token.service";
import type { AuthService } from "../../auth/auth.service";
import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

export function buildMcpToolHandlers(deps: {
  auth: AuthService;
  bearerTokens: McpBearerTokenService;
  prisma: any;
}): McpToolHandler[] {
  const { auth, bearerTokens, prisma } = deps;

  return [
    {
      name: "mcp.list_tokens",
      description:
        "List MCP bearer PATs (`plt_ent_*`) across every entity in scope. " +
        "Aggregates `entities.list` → `bearerTokens.list(entityPk)` for " +
        "each entity that has an `mcpConfig` row. Metadata only — token " +
        "hashes are never returned. To mint a new token, use " +
        "`entities.generate_mcp_token` (require_approval gated). To " +
        "revoke one, use `mcp.revoke_token` once it ships in a future " +
        "wave (currently revoke is per-entity dashboard only). Optional " +
        "`entityId` filter narrows to a single entity. Defaults to " +
        "active tokens (non-revoked, non-expired); pass " +
        "`includeRevoked: true` / `includeExpired: true` to see them.",
      inputSchema: {
        type: "object",
        properties: {
          entityId: { type: "string" },
          includeRevoked: { type: "boolean" },
          includeExpired: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityIdFilter = params["entityId"] as string | undefined;
        const includeRevoked = !!params["includeRevoked"];
        const includeExpired = !!params["includeExpired"];
        const entities = await auth.listEntities(scope.organizationId, scope.projectId);
        const filtered = entityIdFilter
          ? (entities as Array<{ entityId: string }>).filter(
              (e) => e.entityId === entityIdFilter,
            )
          : entities;
        if (filtered.length === 0) {
          return { tokens: [] };
        }
        const now = Date.now();
        const allTokens = await Promise.all(
          (filtered as Array<{ id: string; entityId: string }>).map(async (e) => {
            const rows = await bearerTokens.list(e.id, scope.environmentId);
            return rows.map((r) => ({
              id: r.id,
              entityId: e.entityId,
              entityPk: e.id,
              label: r.label,
              mcpUserId: r.mcpUserId,
              scopes: r.scopes,
              createdAt:
                r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
              lastUsedAt: r.lastUsedAt
                ? r.lastUsedAt instanceof Date
                  ? r.lastUsedAt.toISOString()
                  : String(r.lastUsedAt)
                : null,
              expiresAt: r.expiresAt
                ? r.expiresAt instanceof Date
                  ? r.expiresAt.toISOString()
                  : String(r.expiresAt)
                : null,
              revokedAt: r.revokedAt
                ? r.revokedAt instanceof Date
                  ? r.revokedAt.toISOString()
                  : String(r.revokedAt)
                : null,
              expired: r.expiresAt
                ? (r.expiresAt instanceof Date
                    ? r.expiresAt.getTime()
                    : new Date(r.expiresAt).getTime()) < now
                : false,
              revoked: !!r.revokedAt,
            }));
          }),
        );
        const tokens = allTokens
          .flat()
          .filter((t) => (includeRevoked ? true : !t.revoked))
          .filter((t) => (includeExpired ? true : !t.expired))
          .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
        return { tokens, entitiesScanned: filtered.length };
      },
    },

    {
      name: "mcp.list_clients",
      description:
        "List MCP clients (PIFSP-21 per-entity OAuth DCR clients) with " +
        "active access tokens reaching this org. Joins " +
        "`PlatosOAuthClient` (entity-pinned subset) with the latest " +
        "`PlatosOAuthAccessToken` per (clientId, userId) pair so the " +
        "operator sees who actually has live MCP access — distinct from " +
        "the simple `oauth.list_clients` registry view. Soft-deleted " +
        "clients are excluded. Returns `{ clients: [{ clientId, " +
        "clientName, entityPk, activeUserCount, lastIssuedAt }] }`. " +
        "Metadata only — never returns token hashes.",
      inputSchema: {
        type: "object",
        properties: {
          entityPk: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const entityPkFilter = params["entityPk"] as string | null | undefined;
        const where: Record<string, unknown> = {
          organizationId: scope.organizationId,
          deletedAt: null,
        };
        if (entityPkFilter !== undefined) {
          where["entityPk"] = entityPkFilter;
        } else {
          // Default: only entity-pinned MCP clients (the platform-wide
          // K.10 clients aren't MCP-specific).
          where["entityPk"] = { not: null };
        }
        const clients = await prisma.platosOAuthClient.findMany({
          where,
          select: {
            id: true,
            clientId: true,
            clientName: true,
            entityPk: true,
            redirectUris: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        });
        if (clients.length === 0) {
          return { clients: [] };
        }
        const clientIds = (clients as Array<{ clientId: string }>).map((c) => c.clientId);
        const now = new Date();
        const activeTokens = await prisma.platosOAuthAccessToken.findMany({
          where: {
            clientId: { in: clientIds },
            scopeTuple: { path: ["organizationId"], equals: scope.organizationId },
            revokedAt: null,
            expiresAt: { gt: now },
          },
          select: {
            clientId: true,
            userId: true,
            issuedAt: true,
          },
        });
        const byClient = new Map<
          string,
          { users: Set<string>; lastIssuedAt: Date | null }
        >();
        for (const t of activeTokens as Array<{
          clientId: string;
          userId: string;
          issuedAt: Date;
        }>) {
          let entry = byClient.get(t.clientId);
          if (!entry) {
            entry = { users: new Set(), lastIssuedAt: null };
            byClient.set(t.clientId, entry);
          }
          entry.users.add(t.userId);
          if (!entry.lastIssuedAt || t.issuedAt > entry.lastIssuedAt) {
            entry.lastIssuedAt = t.issuedAt;
          }
        }
        return {
          clients: (clients as Array<{
            id: string;
            clientId: string;
            clientName: string;
            entityPk: string | null;
            redirectUris: string[];
            createdAt: Date;
          }>).map((c) => {
            const stats = byClient.get(c.clientId);
            return {
              id: c.id,
              clientId: c.clientId,
              clientName: c.clientName,
              entityPk: c.entityPk ?? null,
              redirectUris: c.redirectUris,
              createdAt:
                c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
              activeUserCount: stats ? stats.users.size : 0,
              lastIssuedAt: stats?.lastIssuedAt
                ? stats.lastIssuedAt.toISOString()
                : null,
            };
          }),
        };
      },
    },
  ];
}
