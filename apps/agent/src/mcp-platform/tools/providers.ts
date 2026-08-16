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

const SAFE_PROVIDER_KEY_SELECT = {
  id: true,
  provider: true,
  label: true,
  environmentKeyName: true,
  isDefault: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  lastUsedAt: true,
} as const;

function keyResult(row: any): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    envVarName: row.environmentKeyName,
    isDefault: row.isDefault,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === "P2002";
}

function isReferenceConstraintError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === "P2003";
}

function modelProvider(model: string): string | null {
  const separator = model.indexOf(":");
  return separator > 0 ? model.slice(0, separator) : null;
}

export function buildProviderToolHandlers(deps: {
  agentCrud: AgentCrudService;
  providers: ProviderRegistryService;
  scopedEnv: ScopedEnvService;
  toolAudit: ToolAuditService;
  prisma: any;
}): McpToolHandler[] {
  const { agentCrud, providers, scopedEnv, toolAudit, prisma } = deps;

  async function lockProviderDefaults(
    tx: any,
    environmentId: string,
    provider: string,
  ): Promise<void> {
    await tx.$queryRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS locked",
      `${environmentId}:${provider}`,
    );
  }

  async function hasExecutableReference(
    tx: any,
    scope: RequestScope,
    key: { id: string; provider: string },
  ): Promise<boolean> {
    const rows = await tx.$queryRawUnsafe(
      `SELECT version.id
         FROM "ProviderKey" provider_key
         JOIN "Environment" environment ON environment.id = provider_key."environmentId"
         JOIN "Project" project ON project.id = environment."projectId"
         JOIN "AgentBinding" binding ON binding."environmentId" = environment.id
         JOIN "Agent" agent ON agent.id = binding."agentId" AND agent."projectId" = project.id
         JOIN "AgentVersion" version ON version."agentId" = agent.id
        WHERE provider_key.id = $1::uuid
          AND provider_key."environmentId" = $2::uuid
          AND provider_key.provider = $3
          AND project.id = $4::uuid
          AND project."organizationId" = $5::uuid
          AND (
            (
              version."memoryConfig" #>> '{__runtime,providerKeyId}' = provider_key.id::text
              AND split_part(version.model, ':', 1) = provider_key.provider
            )
            OR EXISTS (
              SELECT 1
                FROM jsonb_array_elements(version."modelRoutes") route
               WHERE split_part(COALESCE(route ->> 'model', ''), ':', 1) = provider_key.provider
                 AND (
                   route ->> 'providerCredentialId' = provider_key.id::text
                   OR route ->> 'providerKeyId' = provider_key.id::text
                 )
            )
          )
        LIMIT 1`,
      key.id,
      scope.environmentId,
      key.provider,
      scope.projectId,
      scope.organizationId,
    );
    return Array.isArray(rows) && rows.length > 0;
  }

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
        "plaintext value. Looks up `ProviderKey` by id, attempts " +
        "to resolve the same-Environment, same-provider Credential, and " +
        "returns `{ ok, exists, decryptable, envVarName, provider }`. " +
        "Accepts either `keyId` (the ProviderKey row id) or `providerId` (a backwards-" +
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
        const key = await prisma.providerKey.findFirst({
          where: {
            id: keyId,
            ...environmentScopeWhere(scope),
          },
          select: {
            id: true,
            provider: true,
            environmentKeyName: true,
            label: true,
          },
        });
        if (!key) return { error: "not_found", keyId };
        let exists = false;
        let ready = false;
        try {
          exists = !!(await scopedEnv.findCredentialMetadata(
            tuple(scope),
            key.environmentKeyName,
            key.provider,
          ));
          ready = exists
            && await scopedEnv.hasProviderCredential(tuple(scope), key.provider, key.id);
        } catch {
          ready = false;
        }
        return {
          keyId,
          provider: key.provider,
          label: key.label,
          envVarName: key.environmentKeyName,
          ok: ready,
          exists,
          decryptable: ready,
          ...(!ready ? { error: "provider_credential_unavailable" } : {}),
        };
      },
    },

    {
      name: "providers.list_keys",
      description:
        "List every ProviderKey row in the current scope. " +
        "Optional `provider` filter narrows by manifest id. NEVER " +
        "returns plaintext or encrypted values — only the Credential name + " +
        "metadata. `envVarSet` reflects whether the underlying " +
        "same-provider Credential is present + decryptable in this agent.",
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
        const where: Record<string, unknown> = { ...environmentScopeWhere(t) };
        if (provider) where["provider"] = provider;
        const keys = await prisma.providerKey.findMany({
          where,
          orderBy: [
            { provider: "asc" },
            { isDefault: "desc" },
            { createdAt: "asc" },
          ],
          select: SAFE_PROVIDER_KEY_SELECT,
        });
        const enriched = await Promise.all(
          keys.map(async (k: any) => ({
            ...keyResult(k),
            createdAt:
              k.createdAt instanceof Date ? k.createdAt.toISOString() : String(k.createdAt),
            updatedAt:
              k.updatedAt instanceof Date ? k.updatedAt.toISOString() : String(k.updatedAt),
            lastUsedAt: k.lastUsedAt
              ? k.lastUsedAt instanceof Date
                ? k.lastUsedAt.toISOString()
                : String(k.lastUsedAt)
              : null,
            envVarSet: await scopedEnv
              .hasProviderCredential(t, k.provider, k.id)
              .catch(() => false),
          })),
        );
        return { keys: enriched };
      },
    },

    {
      name: "providers.add_key",
      description:
        "Register a new provider key by referencing an existing " +
        "same-Environment, same-provider Credential name. This tool never " +
        "accepts or returns plaintext. Setting " +
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
        const auditArgs = { provider, label, envVarName, isDefault };
        if (!provider || !label || !envVarName) {
          const err = "provider, label, envVarName required";
          auditMutation(scope, "providers.add_key", auditArgs, null, "failed", startedAt, err);
          return { error: err };
        }
        const credential = await scopedEnv.findCredentialMetadata(
          tuple(scope),
          envVarName,
          provider,
        );
        if (!credential) {
          auditMutation(
            scope,
            "providers.add_key",
            auditArgs,
            null,
            "failed",
            startedAt,
            "credential_not_found",
          );
          return { error: "credential_not_found" };
        }
        try {
          const key = await prisma.$transaction(async (tx: any) => {
            if (isDefault) {
              await lockProviderDefaults(tx, scope.environmentId, provider);
              await tx.providerKey.updateMany({
                where: {
                  ...environmentScopeWhere(scope),
                  provider,
                  isDefault: true,
                },
                data: { isDefault: false },
              });
            }
            return tx.providerKey.create({
              data: {
                environmentId: scope.environmentId,
                provider,
                label,
                environmentKeyName: credential.name,
                encryptedReference: `credential://${credential.id}`,
                isDefault,
                createdBy: scope.userId ?? "mcp:platform",
              },
              select: SAFE_PROVIDER_KEY_SELECT,
            });
          });
          const result = {
            keyId: key.id,
            provider: key.provider,
            label: key.label,
            envVarName: key.environmentKeyName,
            isDefault: key.isDefault,
            createdAt:
              key.createdAt instanceof Date
                ? key.createdAt.toISOString()
                : String(key.createdAt),
          };
          auditMutation(
            scope,
            "providers.add_key",
            auditArgs,
            result,
            "success",
            startedAt,
          );
          return result;
        } catch (err: unknown) {
          auditMutation(
            scope,
            "providers.add_key",
            auditArgs,
            null,
            "failed",
            startedAt,
            "add_key_failed",
          );
          if (isUniqueConstraintError(err)) {
            return {
              error: "already_exists",
              message:
                "A provider key with this envVarName already exists in this scope+provider.",
            };
          }
          return { error: "add_key_failed" };
        }
      },
    },

    {
      name: "providers.delete_key",
      description:
        "Delete a ProviderKey row. Refuses if any executable agent version " +
        "in scope references this key. Does not delete its Credential. Scope-pinned. " +
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
        const auditArgs = { keyId };
        let outcome:
          | { status: "not_found" }
          | { status: "pinned" }
          | { status: "deleted"; key: any };
        try {
          outcome = await prisma.$transaction(async (tx: any) => {
            const existing = await tx.providerKey.findFirst({
              where: { id: keyId, ...environmentScopeWhere(scope) },
              select: {
                id: true,
                provider: true,
                label: true,
                environmentKeyName: true,
              },
            });
            if (!existing) return { status: "not_found" as const };
            await lockProviderDefaults(tx, scope.environmentId, existing.provider);
            if (await hasExecutableReference(tx, scope, existing)) {
              return { status: "pinned" as const };
            }
            await tx.providerKey.delete({ where: { id: keyId } });
            return { status: "deleted" as const, key: existing };
          });
        } catch (error) {
          if (isReferenceConstraintError(error)) {
            outcome = { status: "pinned" };
          } else {
            auditMutation(
              scope,
              "providers.delete_key",
              auditArgs,
              null,
              "failed",
              startedAt,
              "delete_failed",
            );
            return { error: "delete_failed" };
          }
        }
        if (outcome.status === "not_found") {
          auditMutation(scope, "providers.delete_key", auditArgs, null, "failed", startedAt, "not_found");
          return { error: "not_found", keyId };
        }
        if (outcome.status === "pinned") {
          auditMutation(scope, "providers.delete_key", auditArgs, null, "failed", startedAt, "pinned_agents");
          return {
            error: "pinned_agents",
            message: "One or more executable agent versions reference this key. Update them first.",
          };
        }
        const existing = outcome.key;
        const result = {
          deleted: true,
          keyId,
          provider: existing.provider,
          label: existing.label,
          envVarName: existing.environmentKeyName,
        };
        auditMutation(scope, "providers.delete_key", auditArgs, result, "success", startedAt);
        return result;
      },
    },

    {
      name: "providers.rotate_key",
      description:
        "Repoint an existing ProviderKey at a different same-Environment, " +
        "same-provider Credential. Optional `label` renames the key in the " +
        "same operation. This tool never accepts or returns plaintext. Audit-logged.",
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
        const auditArgs = { keyId, envVarName, ...(label ? { label } : {}) };
        const existing = await prisma.providerKey.findFirst({
          where: {
            id: keyId,
            ...environmentScopeWhere(scope),
          },
          select: {
            id: true,
            provider: true,
            environmentKeyName: true,
            label: true,
          },
        });
        if (!existing) {
          auditMutation(scope, "providers.rotate_key", auditArgs, null, "failed", startedAt, "not_found");
          return { error: "not_found", keyId };
        }
        const credential = await scopedEnv.findCredentialMetadata(
          tuple(scope),
          envVarName,
          existing.provider,
        );
        if (!credential) {
          auditMutation(
            scope,
            "providers.rotate_key",
            auditArgs,
            null,
            "failed",
            startedAt,
            "credential_not_found",
          );
          return { error: "credential_not_found" };
        }
        try {
          const rotation = await prisma.$transaction(async (tx: any) => {
            const current = await tx.providerKey.findFirst({
              where: {
                id: keyId,
                provider: existing.provider,
                ...environmentScopeWhere(scope),
              },
              select: { id: true, environmentKeyName: true },
            });
            if (!current) return null;
            const previousEnvVarName = current.environmentKeyName;
            const updated = await tx.providerKey.update({
              where: { id: keyId },
              data: {
                environmentKeyName: credential.name,
                encryptedReference: `credential://${credential.id}`,
                ...(label ? { label } : {}),
              },
              select: SAFE_PROVIDER_KEY_SELECT,
            });
            return { updated, previousEnvVarName };
          });
          if (!rotation) {
            auditMutation(scope, "providers.rotate_key", auditArgs, null, "failed", startedAt, "not_found");
            return { error: "not_found", keyId };
          }
          const { updated, previousEnvVarName } = rotation;
          scopedEnv.invalidate(tuple(scope), previousEnvVarName);
          scopedEnv.invalidate(tuple(scope), envVarName);
          const result = {
            rotated: true,
            keyId,
            provider: updated.provider,
            label: updated.label,
            previousEnvVarName,
            envVarName: updated.environmentKeyName,
            updatedAt:
              updated.updatedAt instanceof Date
                ? updated.updatedAt.toISOString()
                : String(updated.updatedAt),
          };
          auditMutation(
            scope,
            "providers.rotate_key",
            auditArgs,
            result,
            "success",
            startedAt,
          );
          return result;
        } catch {
          auditMutation(scope, "providers.rotate_key", auditArgs, null, "failed", startedAt, "rotate_failed");
          return { error: "rotate_failed" };
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
