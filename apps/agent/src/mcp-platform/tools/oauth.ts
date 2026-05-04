/**
 * Theme MCPF-W3 — OAuth client + token management MCP tools.
 *
 * These wrap `OAuthService` so an operator can manage Platos's RFC 7591
 * dynamic client registry from outside the webapp:
 *
 *   • `oauth.list_clients`   — list OAuth applications (no client secrets)
 *   • `oauth.create_client`  — register a new OAuth app (returns client_secret ONCE)
 *   • `oauth.delete_client`  — soft-delete client + cascade-revoke tokens
 *   • `oauth.list_tokens`    — list outstanding access tokens (metadata only)
 *   • `oauth.revoke_token`   — revoke a specific token by id
 *   • `oauth.rotate_secret`  — issue new client_secret (returned ONCE)
 *
 * Audit redaction discipline matches `entities.set_test_credentials`:
 *   - Plaintext secrets returned ONCE on creation/rotation.
 *   - Audit log records prefix only (first 8 chars) + metadata.
 *   - Token *hashes* are also secrets; never returned in any list.
 *
 * Tier-1 require_approval gates (`oauth.create_client`,
 * `oauth.delete_client`, `oauth.rotate_secret`) live in
 * `permission-gateway.service.ts` PLATFORM_TIER_MINIMUMS.
 */

import type { OAuthService } from "../../oauth/oauth.service";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
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

export function buildOAuthToolHandlers(deps: {
  oauth: OAuthService;
  toolAudit: ToolAuditService;
}): McpToolHandler[] {
  const { oauth, toolAudit } = deps;

  function auditMutation(
    scope: RequestScope,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    status: "success" | "failed",
    startedAt: number,
    error?: string,
  ): void {
    toolAudit
      .record({
        scope: tuple(scope),
        toolName,
        userId: scope.userId ?? null,
        args,
        result,
        ...(error !== undefined ? { error } : {}),
        status,
        latencyMs: Date.now() - startedAt,
        source: "mcp_platform",
      })
      .catch(() => undefined);
  }

  return [
    {
      name: "oauth.list_clients",
      description:
        "List OAuth 2.1 applications registered in the current org. " +
        "Returns safe metadata only — `clientSecretHash` is NEVER " +
        "returned (an attacker with the hash can grind it offline). " +
        "Soft-deleted clients are excluded by default; pass " +
        "`includeDeleted: true` to see them. Optional `entityPk` filter " +
        "narrows to clients pinned to a single entity (PIFSP-21 DCR).",
      inputSchema: {
        type: "object",
        properties: {
          entityPk: { type: ["string", "null"] },
          includeDeleted: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const opts: { entityPk?: string | null; includeDeleted?: boolean } = {};
        if (Object.prototype.hasOwnProperty.call(params, "entityPk")) {
          opts.entityPk = (params["entityPk"] as string | null) ?? null;
        }
        if (typeof params["includeDeleted"] === "boolean") {
          opts.includeDeleted = params["includeDeleted"];
        }
        const clients = await oauth.listClients(scope.organizationId, opts);
        return { clients };
      },
    },

    {
      name: "oauth.create_client",
      description:
        "Register a new OAuth 2.1 application (RFC 7591 Dynamic Client " +
        "Registration). Returns `client_id` + `client_secret` (or just " +
        "`client_id` for public clients). The plaintext " +
        "`client_secret` is shown ONCE — store it now. Defaults to " +
        "`client_secret_basic` confidential client + " +
        "`[authorization_code, refresh_token]` grants. Audit-logged " +
        "(client_id + secret prefix only — never the full secret).",
      inputSchema: {
        type: "object",
        required: ["clientName", "redirectUris"],
        properties: {
          clientName: { type: "string", minLength: 1, maxLength: 200 },
          redirectUris: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: 10,
          },
          tokenEndpointAuthMethod: {
            type: "string",
            enum: ["client_secret_basic", "client_secret_post", "none"],
          },
          grantTypes: {
            type: "array",
            items: { type: "string", enum: ["authorization_code", "refresh_token"] },
            minItems: 1,
            maxItems: 4,
          },
          scope: { type: "string", maxLength: 500 },
          entityPk: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const clientName = String(params["clientName"]).trim();
        const redirectUris = (params["redirectUris"] as string[]) ?? [];
        const tokenEndpointAuthMethod = params["tokenEndpointAuthMethod"] as
          | "client_secret_basic"
          | "client_secret_post"
          | "none"
          | undefined;
        const grantTypes = (params["grantTypes"] as string[] | undefined) ?? undefined;
        const scopeStr = (params["scope"] as string | undefined) ?? undefined;
        const entityPk = (params["entityPk"] as string | null | undefined) ?? undefined;
        try {
          const result = await oauth.register({
            clientName,
            redirectUris,
            ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
            ...(grantTypes ? { grantTypes } : {}),
            ...(scopeStr ? { scope: scopeStr } : {}),
            registeredByUserId: scope.userId ?? "mcp:platform",
            organizationId: scope.organizationId,
            ...(entityPk ? { entityPk } : {}),
          });
          // Redacted audit row — never log the plaintext secret.
          auditMutation(
            scope,
            "oauth.create_client",
            { clientName, redirectUris, tokenEndpointAuthMethod, grantTypes, scope: scopeStr, entityPk },
            {
              client_id: result.client_id,
              ...(result.client_secret
                ? { clientSecretPrefix: result.client_secret.slice(0, 8) }
                : {}),
              tokenEndpointAuthMethod: result.token_endpoint_auth_method,
              grantTypes: result.grant_types,
              redirectUris: result.redirect_uris,
            },
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(
            scope,
            "oauth.create_client",
            { clientName, redirectUris },
            null,
            "failed",
            startedAt,
            message,
          );
          // OAuthError surfaces a code + status; pass through cleanly.
          if (err?.name === "OAuthError" && typeof err.code === "string") {
            return { error: err.code, message };
          }
          return { error: "create_failed", message };
        }
      },
    },

    {
      name: "oauth.delete_client",
      description:
        "Soft-delete an OAuth client + cascade-revoke every outstanding " +
        "access + refresh token for the client. The row stays in place " +
        "for audit reconstruction but is invisible to the protocol layer " +
        "(`findClient` / `verifyClientSecret` skip soft-deleted rows). " +
        "Idempotent — re-deleting an already-deleted client returns " +
        "`{ deleted: true, alreadyDeleted: true }`. Scope-pinned via " +
        "organizationId; cross-org ids return `{ deleted: false }`. " +
        "Audit-logged.",
      inputSchema: {
        type: "object",
        required: ["clientId"],
        properties: { clientId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const clientId = String(params["clientId"]);
        const startedAt = Date.now();
        try {
          const out = await oauth.deleteClient(clientId, scope.organizationId);
          auditMutation(scope, "oauth.delete_client", params, out, "success", startedAt);
          return { clientId, ...out };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(
            scope,
            "oauth.delete_client",
            params,
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "delete_failed", message };
        }
      },
    },

    {
      name: "oauth.list_tokens",
      description:
        "List outstanding OAuth 2.1 access tokens for the org. Metadata " +
        "ONLY — never returns the token hash (sha256 of the bearer is " +
        "also a secret; an attacker with hash + a guessing oracle can " +
        "compromise). Each row exposes a stable opaque `id` (16-char " +
        "prefix of the hash) for `oauth.revoke_token`. Defaults: only " +
        "active (non-revoked, non-expired) tokens, last 100. Pass " +
        "`clientId` to filter to one OAuth app, `entityPk` to filter to " +
        "tokens pinned to a single entity (PIFSP-21).",
      inputSchema: {
        type: "object",
        properties: {
          clientId: { type: "string" },
          entityPk: { type: ["string", "null"] },
          includeRevoked: { type: "boolean" },
          includeExpired: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const opts: {
          clientId?: string;
          entityPk?: string | null;
          includeRevoked?: boolean;
          includeExpired?: boolean;
          limit?: number;
        } = {};
        if (typeof params["clientId"] === "string") opts.clientId = params["clientId"];
        if (Object.prototype.hasOwnProperty.call(params, "entityPk")) {
          opts.entityPk = (params["entityPk"] as string | null) ?? null;
        }
        if (typeof params["includeRevoked"] === "boolean") {
          opts.includeRevoked = params["includeRevoked"];
        }
        if (typeof params["includeExpired"] === "boolean") {
          opts.includeExpired = params["includeExpired"];
        }
        if (typeof params["limit"] === "number") opts.limit = params["limit"];
        const tokens = await oauth.listAccessTokens(scope.organizationId, opts);
        return { tokens };
      },
    },

    {
      name: "oauth.revoke_token",
      description:
        "Revoke a single OAuth access token by its 16-char `id` (= prefix " +
        "of the sha256 token hash returned by `oauth.list_tokens`). " +
        "Scope-pinned by organizationId. Returns `{ revoked: true }` on " +
        "success, `{ revoked: false }` for unknown / cross-org / " +
        "already-revoked ids (RFC 7009 §2.2 — unknown tokens succeed " +
        "silently). Audit-logged.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", minLength: 8, maxLength: 64 } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["id"]);
        const startedAt = Date.now();
        try {
          const out = await oauth.revokeAccessTokenById(id, scope.organizationId);
          auditMutation(scope, "oauth.revoke_token", params, out, "success", startedAt);
          return { id, ...out };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "oauth.revoke_token", params, null, "failed", startedAt, message);
          return { error: "revoke_failed", message };
        }
      },
    },

    {
      name: "oauth.rotate_secret",
      description:
        "Rotate the `client_secret` of a confidential OAuth client. " +
        "Returns the NEW plaintext secret ONCE — capture it now. The " +
        "old secret stops authenticating immediately. Public clients " +
        "(`tokenEndpointAuthMethod: \"none\"`) cannot be rotated. " +
        "Soft-deleted clients return `{ rotated: false, reason: \"deleted\" }`. " +
        "Scope-pinned by organizationId. Audit-logged (secret prefix " +
        "only — never the full plaintext).",
      inputSchema: {
        type: "object",
        required: ["clientId"],
        properties: { clientId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const clientId = String(params["clientId"]);
        const startedAt = Date.now();
        try {
          const out = await oauth.rotateClientSecret(clientId, scope.organizationId);
          if (!out.rotated) {
            auditMutation(scope, "oauth.rotate_secret", params, out, "failed", startedAt, out.reason);
            return { error: out.reason, clientId };
          }
          // Redacted audit — never log the plaintext secret.
          auditMutation(
            scope,
            "oauth.rotate_secret",
            params,
            {
              clientId: out.clientId,
              clientSecretPrefix: out.clientSecret.slice(0, 8),
              issuedAt: out.issuedAt,
            },
            "success",
            startedAt,
          );
          return out;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "oauth.rotate_secret", params, null, "failed", startedAt, message);
          return { error: "rotate_failed", message };
        }
      },
    },
  ];
}
