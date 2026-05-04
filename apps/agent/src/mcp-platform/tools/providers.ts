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
 *   • `providers.list_keys`        — list every PlatosProviderKey in scope.
 *   • `providers.add_key`          — register a key (ENV-var pointer, not
 *                                    plaintext — secrets stay in SecretStore).
 *   • `providers.delete_key`       — remove a key. Refuses if any agents are
 *                                    pinned to it (mirrors REST controller).
 *   • `providers.rotate_key`       — replace a key's `envVarName` pointer (the
 *                                    plaintext rotation lives in the webapp's
 *                                    SecretStore writer; this tool lets the
 *                                    operator point an existing PlatosProviderKey
 *                                    at the new SecretStore var).
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
import type { ScopedEnvService } from "../../providers/scoped-env.service";
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

export function buildProviderToolHandlers(deps: {
  providers: ProviderRegistryService;
  scopedEnv: ScopedEnvService;
  toolAudit: ToolAuditService;
  prisma: any;
}): McpToolHandler[] {
  const { providers, scopedEnv, toolAudit, prisma } = deps;

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
        "Health-check a registered provider key without returning the " +
        "plaintext value. Looks up `PlatosProviderKey` by id, attempts " +
        "to resolve + decrypt the underlying SecretStore row, and " +
        "returns `{ ok, exists, decryptable, envVarName, provider }`. " +
        "`exists=true, decryptable=false` is the canonical signal of a " +
        "webapp ↔ agent ENCRYPTION_KEY mismatch. Accepts either `keyId` " +
        "(the PlatosProviderKey row id) or `providerId` (a backwards-" +
        "compat alias some callers ship).",
      inputSchema: {
        type: "object",
        // MCPF-followup — neither field is required individually; the
        // handler enforces "at least one of keyId / providerId" so the
        // schema validator returns a clean error instead of letting
        // `String(undefined)` cascade into a not_found.
        properties: {
          keyId: { type: "string" },
          providerId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        // MCPF-followup — accept providerId as alias for keyId.
        const rawKey = (params["keyId"] as string | undefined)
          ?? (params["providerId"] as string | undefined);
        if (!rawKey || typeof rawKey !== "string" || rawKey.length === 0) {
          return {
            error: "invalid_input",
            message: "providers.test_credentials: one of `keyId` or `providerId` is required",
          };
        }
        const keyId = rawKey;
        const key = await prisma.platosProviderKey.findFirst({
          where: {
            id: keyId,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          select: { id: true, provider: true, envVarName: true, label: true },
        });
        if (!key) return { error: "not_found", keyId };
        const probe = await scopedEnv.test(tuple(scope), key.envVarName);
        return {
          keyId,
          provider: key.provider,
          label: key.label,
          envVarName: key.envVarName,
          ok: probe.ok,
          exists: probe.exists,
          decryptable: probe.decryptable,
          ...(probe.error ? { error: probe.error } : {}),
        };
      },
    },

    {
      name: "providers.list_keys",
      description:
        "List every PlatosProviderKey row in the current scope. " +
        "Optional `provider` filter narrows by manifest id. NEVER " +
        "returns plaintext values — only the SecretStore var name + " +
        "metadata. `envVarSet` reflects whether the underlying " +
        "SecretStore row is present + decryptable in this agent.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const t = tuple(scope);
        const provider = params["provider"] as string | undefined;
        const where: Record<string, unknown> = {
          organizationId: t.organizationId,
          projectId: t.projectId,
          environmentId: t.environmentId,
        };
        if (provider) where["provider"] = provider;
        const keys = await prisma.platosProviderKey.findMany({
          where,
          orderBy: [
            { provider: "asc" },
            { isDefault: "desc" },
            { createdAt: "asc" },
          ],
          select: {
            id: true,
            provider: true,
            label: true,
            envVarName: true,
            isDefault: true,
            createdBy: true,
            createdAt: true,
            updatedAt: true,
            lastUsedAt: true,
          },
        });
        const enriched = await Promise.all(
          keys.map(async (k: any) => ({
            ...k,
            createdAt:
              k.createdAt instanceof Date ? k.createdAt.toISOString() : String(k.createdAt),
            updatedAt:
              k.updatedAt instanceof Date ? k.updatedAt.toISOString() : String(k.updatedAt),
            lastUsedAt: k.lastUsedAt
              ? k.lastUsedAt instanceof Date
                ? k.lastUsedAt.toISOString()
                : String(k.lastUsedAt)
              : null,
            envVarSet: !!(await scopedEnv.get(t, k.envVarName)),
          })),
        );
        return { keys: enriched };
      },
    },

    {
      name: "providers.add_key",
      description:
        "Register a new provider key. The plaintext API key MUST be " +
        "written to the trigger.dev SecretStore separately (via the " +
        "Environment Variables UI or the trigger CLI) — this tool only " +
        "registers the *pointer* (PlatosProviderKey) that maps a " +
        "(provider, label) pair to a SecretStore env-var name. Setting " +
        "`isDefault: true` clears any other default for the same " +
        "provider in scope. Audit-logged (label + envVarName only — " +
        "no plaintext).",
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
        const provider = String(params["provider"]).trim();
        const label = String(params["label"]).trim();
        const envVarName = String(params["envVarName"]).trim();
        const isDefault = !!params["isDefault"];
        const startedAt = Date.now();
        if (!provider || !label || !envVarName) {
          const err = "provider, label, envVarName required";
          auditMutation(scope, "providers.add_key", params, null, "failed", startedAt, err);
          return { error: err };
        }
        // Same uniqueness guard as the REST controller — clear any
        // existing default for this (scope, provider) before flipping a
        // new row to default.
        try {
          if (isDefault) {
            await prisma.platosProviderKey.updateMany({
              where: {
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                environmentId: scope.environmentId,
                provider,
                isDefault: true,
              },
              data: { isDefault: false },
            });
          }
          const key = await prisma.platosProviderKey.create({
            data: {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              provider,
              label,
              envVarName,
              isDefault,
              createdBy: scope.userId ?? "mcp:platform",
            },
            select: {
              id: true,
              provider: true,
              label: true,
              envVarName: true,
              isDefault: true,
              createdAt: true,
            },
          });
          const result = {
            keyId: key.id,
            provider: key.provider,
            label: key.label,
            envVarName: key.envVarName,
            isDefault: key.isDefault,
            createdAt:
              key.createdAt instanceof Date
                ? key.createdAt.toISOString()
                : String(key.createdAt),
          };
          auditMutation(
            scope,
            "providers.add_key",
            { provider, label, envVarName, isDefault },
            result,
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(
            scope,
            "providers.add_key",
            { provider, label, envVarName, isDefault },
            null,
            "failed",
            startedAt,
            message,
          );
          // Unique-constraint collision (same envVarName for same scope+provider).
          if (/unique/i.test(message) || err?.code === "P2002") {
            return {
              error: "already_exists",
              message:
                "A provider key with this envVarName already exists in this scope+provider.",
            };
          }
          return { error: "add_key_failed", message };
        }
      },
    },

    {
      name: "providers.delete_key",
      description:
        "Delete a PlatosProviderKey row. Refuses if any agents in scope " +
        "are pinned to this key (`providerKeyId`) — caller must update " +
        "those agents first. Does NOT delete the SecretStore plaintext " +
        "value (use the trigger.dev UI for that). Scope-pinned. " +
        "Audit-logged.",
      inputSchema: {
        type: "object",
        required: ["keyId"],
        properties: { keyId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const keyId = String(params["keyId"]);
        const startedAt = Date.now();
        const existing = await prisma.platosProviderKey.findFirst({
          where: {
            id: keyId,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          select: { id: true, provider: true, label: true, envVarName: true },
        });
        if (!existing) {
          auditMutation(scope, "providers.delete_key", params, null, "failed", startedAt, "not_found");
          return { error: "not_found", keyId };
        }
        const pinnedCount = await prisma.platosAgent.count({
          where: {
            providerKeyId: keyId,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
        });
        if (pinnedCount > 0) {
          auditMutation(
            scope,
            "providers.delete_key",
            params,
            { pinnedAgents: pinnedCount },
            "failed",
            startedAt,
            "pinned_agents",
          );
          return {
            error: "pinned_agents",
            message: `${pinnedCount} agent(s) are pinned to this key. Update them first.`,
            pinnedAgents: pinnedCount,
          };
        }
        await prisma.platosProviderKey.delete({ where: { id: keyId } });
        const result = {
          deleted: true,
          keyId,
          provider: existing.provider,
          label: existing.label,
          envVarName: existing.envVarName,
        };
        auditMutation(scope, "providers.delete_key", params, result, "success", startedAt);
        return result;
      },
    },

    {
      name: "providers.rotate_key",
      description:
        "Repoint an existing PlatosProviderKey row at a NEW SecretStore " +
        "env-var. Use this after writing the new plaintext to a different " +
        "SecretStore var (e.g. `ANTHROPIC_API_KEY_V2`) to atomically swap " +
        "without recreating the row + every agent's pin. Optional `label` " +
        "rename in the same call. Does NOT touch the underlying " +
        "SecretStore — the new var must already exist or `envVarSet` will " +
        "report `false` until it does. Audit-logged.",
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
        const keyId = String(params["keyId"]);
        const envVarName = String(params["envVarName"]).trim();
        const label = (params["label"] as string | undefined)?.trim();
        const startedAt = Date.now();
        const existing = await prisma.platosProviderKey.findFirst({
          where: {
            id: keyId,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          select: { id: true, provider: true, envVarName: true, label: true },
        });
        if (!existing) {
          auditMutation(scope, "providers.rotate_key", params, null, "failed", startedAt, "not_found");
          return { error: "not_found", keyId };
        }
        try {
          const updated = await prisma.platosProviderKey.update({
            where: { id: keyId },
            data: {
              envVarName,
              ...(label ? { label } : {}),
            },
            select: {
              id: true,
              provider: true,
              label: true,
              envVarName: true,
              isDefault: true,
              updatedAt: true,
            },
          });
          // Invalidate the scoped-env cache so the new var resolves
          // immediately (the OLD envVarName probably still has a cached
          // value from prior reads).
          scopedEnv.invalidate(tuple(scope), existing.envVarName);
          scopedEnv.invalidate(tuple(scope), envVarName);
          const result = {
            rotated: true,
            keyId,
            provider: updated.provider,
            label: updated.label,
            previousEnvVarName: existing.envVarName,
            envVarName: updated.envVarName,
            updatedAt:
              updated.updatedAt instanceof Date
                ? updated.updatedAt.toISOString()
                : String(updated.updatedAt),
          };
          auditMutation(
            scope,
            "providers.rotate_key",
            { keyId, envVarName, ...(label ? { label } : {}) },
            result,
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "providers.rotate_key", params, null, "failed", startedAt, message);
          return { error: "rotate_failed", message };
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
            return { error: "invalid_route", route: r };
          }
          cleaned.push({
            label: r.label.trim(),
            model: r.model.trim(),
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
        const agent = await prisma.platosAgent.findFirst({
          where: {
            id: agentId,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          select: { id: true },
        });
        if (!agent) {
          auditMutation(scope, "providers.set_routes", params, null, "failed", startedAt, "agent_not_found");
          return { error: "agent_not_found", agentId };
        }
        // Validate each providerKeyId is in scope.
        const referencedKeyIds = Array.from(
          new Set(cleaned.map((r) => r.providerKeyId).filter((x): x is string => !!x)),
        );
        if (referencedKeyIds.length > 0) {
          const known = await prisma.platosProviderKey.findMany({
            where: {
              id: { in: referencedKeyIds },
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            select: { id: true },
          });
          const knownIds = new Set((known as Array<{ id: string }>).map((k) => k.id));
          const bogus = referencedKeyIds.filter((id) => !knownIds.has(id));
          if (bogus.length > 0) {
            auditMutation(
              scope,
              "providers.set_routes",
              params,
              { unknownProviderKeyIds: bogus },
              "failed",
              startedAt,
              "unknown_provider_key_ids",
            );
            return { error: "unknown_provider_key_ids", unknownProviderKeyIds: bogus };
          }
        }
        await prisma.platosAgent.update({
          where: { id: agentId },
          data: { modelRoutes: cleaned.length === 0 ? null : cleaned },
        });
        const result = {
          ok: true,
          agentId,
          routeCount: cleaned.length,
          labels,
        };
        auditMutation(
          scope,
          "providers.set_routes",
          { agentId, routeCount: cleaned.length, labels },
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
        const where: Record<string, unknown> = {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        };
        if (agentId) where["id"] = agentId;
        const agents = await prisma.platosAgent.findMany({
          where,
          select: {
            id: true,
            slug: true,
            name: true,
            model: true,
            providerKeyId: true,
            modelRoutes: true,
          },
          orderBy: { createdAt: "desc" },
        });
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
