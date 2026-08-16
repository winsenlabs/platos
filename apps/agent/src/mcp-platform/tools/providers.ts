/**
 * Theme MCPF-W3 — Provider integration MCP tools.
 *
 * These complement the K.8 `providers.list` / `providers.link` /
 * `providers.unlink` baseline already in `tools/platos-control.ts`. The
 * extension surface mirrors what an operator can do from the dashboard
 * Providers page + per-agent route picker:
 *
 *   • `providers.get`             — single-provider details (state + manifest)
 *   • `providers.test_credentials` — health-check a registered key without
 *                                    returning the plaintext.
 *   • `providers.list_keys`        — list every ProviderKey in scope.
 *   • `providers.add_key`          — register a key (Credential reference,
 *                                    never plaintext).
 *   • `providers.delete_key`       — remove a key. Refuses if any agents are
 *                                    pinned to it (mirrors REST controller).
 *   • `providers.rotate_key`       — replace a key's Credential reference.
 *   • `providers.set_routes`       — write per-agent `modelRoutes` JSON.
 *   • `providers.get_routes`       — read `modelRoutes` for one agent or all
 *                                    agents in scope.
 *
 * Audit logging mirrors `entities.ts`: mutations always record only metadata
 * (label / envVarName / agentId / count), never plaintext values. Tier-1
 * approval gates (`providers.add_key`, `providers.delete_key`,
 * `providers.rotate_key`, `providers.set_routes`) live in
 * `permission-gateway.service.ts` PLATFORM_TIER_MINIMUMS.
 */

import type { ProviderRegistryService } from "../../providers/provider-registry.service";
import {
  ProviderKeyError,
  type ProviderKeyService,
} from "../../providers/provider-key.service";
import type { ScopedEnvService } from "../../providers/scoped-env.service";
import type { AgentCrudService } from "../../agent-runtime/agent-crud.service";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import { environmentScopeWhere } from "../../shared/database.provider";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

interface ModelRoute {
  label: string;
  model: string;
  providerKeyId: string | null;
  isDefault: boolean;
}

function isModelRoute(x: unknown): x is ModelRoute {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r["label"] === "string" &&
    typeof r["model"] === "string" &&
    (r["providerKeyId"] === null || typeof r["providerKeyId"] === "string") &&
    typeof r["isDefault"] === "boolean"
  );
}

function modelProvider(model: string): string | null {
  const separator = model.indexOf(":");
  return separator > 0 ? model.slice(0, separator) : null;
}

export function buildProviderToolHandlers(deps: {
  agentCrud: AgentCrudService;
  providers: ProviderRegistryService;
  providerKeys: ProviderKeyService;
  scopedEnv: ScopedEnvService;
  toolAudit: ToolAuditService;
  prisma: any;
}): McpToolHandler[] {
  const { agentCrud, providers, providerKeys, scopedEnv, toolAudit, prisma } = deps;

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
      name: "providers.get",
      description:
        "Fetch a single provider's manifest + scope state (envReady, " +
        "enabled, linked, models, requiredEnv with per-var set/unset). " +
        "Returns `{ error: 'not_found' }` for unknown providerId.",
      inputSchema: {
        type: "object",
        required: ["providerId"],
        properties: { providerId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const providerId = String(params["providerId"]);
        const state = await providers.getOne(tuple(scope), providerId);
        if (!state) return { error: "not_found", providerId };
        return state;
      },
    },

    {
      name: "providers.test_credentials",
      description:
        "Resolve one registered same-Environment provider key without returning plaintext.",
      inputSchema: {
        type: "object",
        properties: { keyId: { type: "string" }, providerId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const keyId = String(params["keyId"] ?? params["providerId"] ?? "");
        if (!keyId) return { error: "invalid_input" };
        try {
          const key = await providerKeys.get(scope, keyId);
          const value = await scopedEnv.getProviderApiKey(
            tuple(scope),
            key.provider,
            key.envVarName,
            key.id,
          );
          const ready = value !== undefined;
          return {
            keyId: key.id,
            provider: key.provider,
            label: key.label,
            envVarName: key.envVarName,
            ok: ready,
            exists: true,
            decryptable: ready,
            ...(!ready ? { error: "provider_credential_unavailable" } : {}),
          };
        } catch {
          return { error: "not_found", keyId };
        }
      },
    },

    {
      name: "providers.list_keys",
      description:
        "List safe ProviderKey metadata in the current Environment without decrypting credentials.",
      inputSchema: {
        type: "object",
        properties: { provider: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const provider = (params["provider"] as string | undefined)?.trim();
        const keys = await providerKeys.list(scope, provider || undefined);
        return { keys };
      },
    },

    {
      name: "providers.add_key",
      description:
        "Link an existing same-Environment, same-provider Credential name. Plaintext is never accepted or returned.",
      inputSchema: {
        type: "object",
        required: ["provider", "label", "envVarName"],
        properties: {
          provider: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1, maxLength: 200 },
          envVarName: { type: "string", minLength: 1, maxLength: 200 },
          isDefault: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const provider = String(params["provider"] ?? "").trim();
        const label = String(params["label"] ?? "").trim();
        const envVarName = String(params["envVarName"] ?? "").trim();
        const isDefault = !!params["isDefault"];
        const startedAt = Date.now();
        const auditArgs = { provider, label, envVarName, isDefault };
        if (!provider || !label || !envVarName) return { error: "invalid_input" };
        try {
          const key = await providerKeys.create(scope, { provider, label, envVarName, isDefault });
          const result = { keyId: key.id, provider, label, envVarName, isDefault: key.isDefault };
          auditMutation(scope, "providers.add_key", auditArgs, result, "success", startedAt);
          return result;
        } catch (error: unknown) {
          const code = error instanceof ProviderKeyError ? error.code : "add_key_failed";
          auditMutation(scope, "providers.add_key", auditArgs, null, "failed", startedAt, code);
          return { error: code };
        }
      },
    },

    {
      name: "providers.delete_key",
      description:
        "Delete safe ProviderKey metadata unless a canonical executable AgentVersion references it.",
      inputSchema: {
        type: "object",
        required: ["keyId"],
        properties: { keyId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const keyId = String(params["keyId"] ?? "");
        const startedAt = Date.now();
        try {
          const key = await providerKeys.delete(scope, keyId);
          const result = { deleted: true, keyId, provider: key.provider, label: key.label, envVarName: key.envVarName };
          auditMutation(scope, "providers.delete_key", { keyId }, result, "success", startedAt);
          return result;
        } catch (error: unknown) {
          const code = error instanceof ProviderKeyError ? error.code : "delete_failed";
          auditMutation(scope, "providers.delete_key", { keyId }, null, "failed", startedAt, code);
          return { error: code };
        }
      },
    },

    {
      name: "providers.rotate_key",
      description:
        "Relink a ProviderKey to an existing same-Environment, same-provider Credential name without accepting plaintext.",
      inputSchema: {
        type: "object",
        required: ["keyId", "envVarName"],
        properties: {
          keyId: { type: "string" },
          envVarName: { type: "string", minLength: 1, maxLength: 200 },
          label: { type: "string", minLength: 1, maxLength: 200 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const keyId = String(params["keyId"] ?? "");
        const envVarName = String(params["envVarName"] ?? "").trim();
        const label = (params["label"] as string | undefined)?.trim();
        const startedAt = Date.now();
        const auditArgs = { keyId, envVarName, ...(label ? { label } : {}) };
        try {
          const rotation = await providerKeys.rotateReference(scope, keyId, { envVarName, ...(label ? { label } : {}) });
          scopedEnv.invalidate(tuple(scope), rotation.previousEnvVarName);
          scopedEnv.invalidate(tuple(scope), envVarName);
          const result = {
            rotated: true,
            keyId,
            provider: rotation.key.provider,
            label: rotation.key.label,
            previousEnvVarName: rotation.previousEnvVarName,
            envVarName: rotation.key.envVarName,
          };
          auditMutation(scope, "providers.rotate_key", auditArgs, result, "success", startedAt);
          return result;
        } catch (error: unknown) {
          const code = error instanceof ProviderKeyError ? error.code : "rotate_failed";
          auditMutation(scope, "providers.rotate_key", auditArgs, null, "failed", startedAt, code);
          return { error: code, keyId };
        }
      },
    },

    {
      name: "providers.set_routes",
      description:
        "Write the per-agent `modelRoutes` JSON column. Routes are an " +
        "operator-defined map of human labels (\"alpha\"/\"fast\"/\"smart\"…) " +
        "to (model, providerKeyId) pairs the runtime picks at request " +
        "time via `modelLabel`. Validates each route's `providerKeyId` " +
        "belongs to this scope. Pass `routes: []` to clear and fall back " +
        "to the agent's legacy `model` + `providerKeyId` fields. " +
        "Audit-logged (route count + labels, never inferred secrets).",
      inputSchema: {
        type: "object",
        required: ["agentId", "routes"],
        properties: {
          agentId: { type: "string" },
          routes: {
            type: "array",
            items: {
              type: "object",
              required: ["label", "model", "providerKeyId", "isDefault"],
              properties: {
                label: { type: "string", minLength: 1, maxLength: 64 },
                model: { type: "string", minLength: 1, maxLength: 200 },
                providerKeyId: { type: ["string", "null"] },
                isDefault: { type: "boolean" },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const agentId = String(params["agentId"]);
        const rawRoutes = (params["routes"] as unknown[]) ?? [];
        const startedAt = Date.now();
        if (!Array.isArray(rawRoutes)) {
          return { error: "routes_must_be_array" };
        }
        if (rawRoutes.length > 32) {
          return { error: "too_many_routes", limit: 32 };
        }
        const cleaned: ModelRoute[] = [];
        for (const r of rawRoutes) {
          if (!isModelRoute(r)) {
            return { error: "invalid_route" };
          }
          const label = r.label.trim();
          const model = r.model.trim();
          if (!label || !model) return { error: "invalid_route" };
          cleaned.push({
            label,
            model,
            providerKeyId: r.providerKeyId,
            isDefault: r.isDefault,
          });
        }
        // Forge guards.
        const labels = cleaned.map((r) => r.label);
        if (new Set(labels).size !== labels.length) {
          return { error: "duplicate_labels" };
        }
        const defaults = cleaned.filter((r) => r.isDefault);
        if (defaults.length > 1) {
          return { error: "multiple_defaults" };
        }
        const auditArgs = { agentId, routeCount: cleaned.length, labels };
        const agent = await agentCrud.findById(agentId, scope);
        if (!agent) {
          auditMutation(scope, "providers.set_routes", auditArgs, null, "failed", startedAt, "agent_not_found");
          return { error: "agent_not_found", agentId };
        }
        // Validate each providerKeyId is in scope.
        const referencedKeyIds = Array.from(
          new Set(cleaned.map((r) => r.providerKeyId).filter((x): x is string => !!x)),
        );
        if (referencedKeyIds.length > 0) {
          const known = await prisma.providerKey.findMany({
            where: {
              id: { in: referencedKeyIds },
              ...environmentScopeWhere(scope),
            },
            select: { id: true, provider: true },
          });
          const knownById = new Map(
            (known as Array<{ id: string; provider: string }>).map((key) => [key.id, key.provider]),
          );
          const bogus = referencedKeyIds.filter((id) => {
            const actualProvider = knownById.get(id);
            return !actualProvider || cleaned.some((route) => {
              if (route.providerKeyId !== id) return false;
              const expectedProvider = modelProvider(route.model);
              return !!expectedProvider && actualProvider !== expectedProvider;
            });
          });
          if (bogus.length > 0) {
            auditMutation(
              scope,
              "providers.set_routes",
              auditArgs,
              { unknownProviderKeyIds: bogus },
              "failed",
              startedAt,
              "unknown_provider_key_ids",
            );
            return { error: "unknown_provider_key_ids", unknownProviderKeyIds: bogus };
          }
        }
        try {
          await agentCrud.update(agentId, scope, {
            modelRoutes: cleaned.length === 0 ? null : cleaned,
            versionNote: "Updated by providers.set_routes",
          });
        } catch {
          auditMutation(
            scope,
            "providers.set_routes",
            auditArgs,
            null,
            "failed",
            startedAt,
            "set_routes_failed",
          );
          return { error: "set_routes_failed" };
        }
        const result = {
          ok: true,
          agentId,
          routeCount: cleaned.length,
          labels,
        };
        auditMutation(
          scope,
          "providers.set_routes",
          auditArgs,
          result,
          "success",
          startedAt,
        );
        return result;
      },
    },

    {
      name: "providers.get_routes",
      description:
        "Read `modelRoutes` for one agent (passing `agentId`) or for " +
        "every agent in scope (omit `agentId`). Returns each agent's " +
        "configured routes plus the legacy `model` + `providerKeyId` " +
        "pair the runtime falls back to when `modelRoutes` is empty.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const agentId = params["agentId"] as string | undefined;
        const agents = agentId
          ? [await agentCrud.findById(agentId, scope)].filter((agent) => agent !== null)
          : await agentCrud.list(scope);
        if (agentId && agents.length === 0) {
          return { error: "agent_not_found", agentId };
        }
        return {
          agents: (agents as Array<{
            id: string;
            slug: string;
            name: string;
            model: string;
            providerKeyId: string | null;
            modelRoutes: unknown;
          }>).map((a) => ({
            agentId: a.id,
            slug: a.slug,
            name: a.name,
            fallback: { model: a.model, providerKeyId: a.providerKeyId ?? null },
            routes: Array.isArray(a.modelRoutes) ? (a.modelRoutes as unknown[]) : [],
          })),
        };
      },
    },
  ];
}
