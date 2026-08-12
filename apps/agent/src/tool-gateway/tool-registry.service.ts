import { Injectable, Inject, OnModuleInit } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { BM25Index, tokenize } from "./bm25";
import * as crypto from "crypto";
import type { RequestScope } from "../auth/scope.guard";

export interface ToolSchema {
  name: string;
  description: string;
  paramSchema: Record<string, unknown>;
  category?: string;
}

export interface RegisteredTool extends ToolSchema {
  id: string;
  schemaHash: string;
  bm25Tokens: string[];
}

export interface OrgToolEntry {
  toolId: string;
  toolName: string;
  description: string;
  paramSchema: Record<string, unknown>;
  category: string | null;
  callbackUrl: string;
  /** Human-readable entity slug (e.g. "fandesk-main"). Was "source" in the old model. */
  sourceEntityId: string;
  /** FK to PlatosConnectedEntity.id — opaque CUID. */
  entityPk: string;
  enabled: boolean;
  /**
   * Per-entity agent allow-list denormalized onto the tool row so the
   * scoped-matrix filter is O(1) instead of a second lookup. Empty
   * array = unrestricted (every agent in scope sees this tool — back-compat
   * default). Non-empty = only the listed PlatosAgent.id values see it.
   * Kept in sync with PlatosConnectedEntity.linkedAgentIds via
   * `syncEntityLinkedAgents` (called by the entity PATCH handler).
   */
  linkedAgentIds: string[];
  /**
   * MCPF-followup: per-entity opt-in for `_context` envelope injection
   * into MCP-origin tool-call arguments. Mirrors
   * PlatosEntityMcpConfig.injectMcpContext. Default false — entity
   * backends that don't accept unexpected kwargs would crash on
   * TypeError. ToolExecutorService gates the PIFSP-21 origin-merge on
   * this flag.
   */
  entityMcpInjectContext: boolean;
}

/**
 * Composite key for scope+entity cache lookups.
 * Format: `${orgId}:${projectId}:${envId}:${entityId}`
 */
function scopeEntityKey(
  scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
  sourceEntityId: string,
): string {
  return `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${sourceEntityId}`;
}

function scopePrefix(scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">): string {
  return `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:`;
}

/**
 * Per-entity agent allow-list check. Empty array on the entry means
 * "no restriction" (back-compat default — every agent in the scope sees
 * this tool). Undefined agentId means the caller isn't scoping to an
 * agent and wants the full matrix (e.g. the Tools tab listing). Any
 * caller who DOES pass an agentId gets filtered via the allow-list.
 */
function isVisibleToAgent(entry: OrgToolEntry, agentId?: string): boolean {
  if (!agentId) return true;
  const allow = entry.linkedAgentIds;
  if (!Array.isArray(allow) || allow.length === 0) return true;
  return allow.includes(agentId);
}

/**
 * ToolRegistryService — manages the central tool registry and per-scope tool matrix.
 *
 * Central registry: one row per unique tool (PlatosToolDefinition)
 * Entity matrix:    one row per (tool, entity, environment) (PlatosEntityToolMapping)
 * BM25 index: in-memory, rebuilt on startup, updated on registration
 *
 * When an entity connects via WebSocket and pushes tools:
 *   1. Each tool is upserted into the central registry (matched by name + schema hash)
 *   2. A PlatosEntityToolMapping row is created linking the tool to the entity+env
 *      with its callback URL
 *   3. The BM25 index is updated
 *
 * When an agent calls find_tools:
 *   1. BM25 search against the index
 *   2. Filter results to only tools enabled for the requesting scope
 *      (optionally further filtered to a single entity)
 *   3. Return tool names + descriptions + param summaries
 */
@Injectable()
export class ToolRegistryService implements OnModuleInit {
  private prisma: any;
  private bm25 = new BM25Index();
  /**
   * Cache keyed by `${org}:${project}:${env}:${entity}` → Map<toolName, entry>.
   * Tools live per scope AND per entity — scanning with the org:project:env
   * prefix yields all scoped tools regardless of entity.
   */
  private scopedToolCache = new Map<string, Map<string, OrgToolEntry>>();

  constructor(@Inject(PRISMA_TOKEN) prisma: any) {
    this.prisma = prisma;
  }

  async onModuleInit() {
    try {
      await this.rebuildIndex();
    } catch (error: any) {
      // Tables might not exist on first boot before migrations run.
      // The service still works — tools just won't be pre-loaded from DB.
      console.warn(`[Platos ToolRegistry] Index rebuild skipped (tables may not exist yet): ${error?.code || error?.message}`);
    }
  }

  /**
   * Rebuild the BM25 index from the database.
   * Called on startup and after bulk operations.
   */
  async rebuildIndex(): Promise<void> {
    try {
      // A rebuild must REPLACE, not merge. Buckets were only ever created when
      // absent and written into, so re-running this could add and update
      // entries but never remove one — leaving a deleted entity's tools live in
      // memory with no way to clear them short of a process restart. Clearing
      // first makes this the operational recovery path it always read like.
      this.scopedToolCache.clear();

      const tools = await this.prisma.platosToolDefinition.findMany();
      for (const tool of tools) {
        const text = `${tool.name} ${tool.description} ${this.extractParamNames(tool.paramSchema)}`;
        this.bm25.addDocument(tool.id, text);
      }

      // Load entity mappings into cache, joining to entity so we know scope.
      // Include mcpConfig so `injectMcpContext` lands on the cached entry —
      // gates the PIFSP-21 `_context` envelope merge in ToolExecutorService.
      const mappings = await this.prisma.platosEntityToolMapping.findMany({
        include: { tool: true, entity: { include: { mcpConfig: true } } },
        // PROMPT-CACHE DETERMINISM (audit finding 6). The scoped-tool cache is
        // a Map seeded in this order, and `collectScopedEntries` iterates it in
        // insertion order. That order reaches the SYSTEM PROMPT through the
        // CTX.6 arg-expectations block, so an unordered findMany means two
        // agent replicas serving the same thread render different bytes and
        // every replica switch is a full cache invalidation. Explicit order
        // makes it reproducible across processes and restarts.
        orderBy: [{ toolId: "asc" }, { environmentId: "asc" }],
      });
      for (const m of mappings) {
        const entity = m.entity;
        if (!entity) continue;
        const key = `${entity.organizationId}:${entity.projectId}:${m.environmentId}:${entity.entityId}`;
        if (!this.scopedToolCache.has(key)) {
          this.scopedToolCache.set(key, new Map());
        }
        this.scopedToolCache.get(key)!.set(m.tool.name, {
          toolId: m.toolId,
          toolName: m.tool.name,
          description: m.tool.description,
          paramSchema: m.tool.paramSchema,
          category: m.tool.category,
          // `callbackUrl` is nullable in the DB: wire rows carry a real URL,
          // mcp-kind rows carry NULL (dispatch is outbound and never reads it).
          // Coerce NULL to the non-dereferenced "mcp:noop" sentinel so the
          // in-memory `OrgToolEntry.callbackUrl` stays typed `string` and no
          // null-guard churn spreads across the wire call sites. The sentinel
          // is NEVER fetched — the mcpDispatch branch returns before the wire
          // serviceSecret/callback block reads it. (design §1.3)
          callbackUrl: m.callbackUrl ?? "mcp:noop",
          sourceEntityId: entity.entityId,
          entityPk: entity.id,
          enabled: m.enabled,
          linkedAgentIds: Array.isArray(entity.linkedAgentIds)
            ? (entity.linkedAgentIds as string[])
            : [],
          entityMcpInjectContext: entity.mcpConfig?.injectMcpContext === true,
        });
      }

      const stats = this.bm25.getStats();
      console.log(`[Platos ToolRegistry] Index rebuilt: ${stats.totalDocs} tools, ${stats.uniqueTerms} terms, ${this.scopedToolCache.size} (scope,entity) buckets`);
    } catch (error) {
      console.error("[Platos ToolRegistry] Failed to rebuild index:", error);
    }
  }

  /**
   * Register tools from an entity. Called when the entity connects via WebSocket
   * and pushes its tool schemas (wire kind), OR by `EntityMcpDiscoveryService`
   * once per project environment after an outbound `tools/list` (mcp kind).
   * The mapping is keyed by (entity, environment).
   *
   * `callbackUrl` is optional: wire entities pass their per-env callback URL;
   * mcp-kind entities pass `null`/omit it (dispatch is outbound via the MCP
   * client and never reads a callback). A null persists as NULL in the now-
   * nullable `PlatosEntityToolMapping.callbackUrl` column and is coerced to the
   * "mcp:noop" sentinel for the in-memory cache entry so `OrgToolEntry.callbackUrl`
   * stays typed `string`. (design §1.3 / §4)
   */
  async registerTools(
    params: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      entityPk: string;        // PlatosConnectedEntity.id
      sourceEntityId: string;  // human-readable entity slug
    },
    tools: ToolSchema[],
    callbackUrl?: string | null,
  ): Promise<{ registered: number; updated: number; newTools: number }> {
    let registered = 0;
    let updated = 0;
    let newTools = 0;

    // Pull the entity's linkedAgentIds + mcpConfig.injectMcpContext ONCE
    // up-front so every tool entry cached in this batch carries the same
    // metadata. Cheap — a single row read — and avoids re-querying inside
    // the per-tool loop. When the entity row isn't found (shouldn't
    // happen; the WS upgrade creates it), default to `[]` (unrestricted)
    // and `false` (no `_context` envelope injection — back-compat).
    const entityRow = await this.prisma.platosConnectedEntity.findFirst({
      where: { id: params.entityPk },
      select: { linkedAgentIds: true, mcpConfig: { select: { injectMcpContext: true } } },
    });
    const linkedAgentIds: string[] =
      entityRow && Array.isArray(entityRow.linkedAgentIds)
        ? (entityRow.linkedAgentIds as string[])
        : [];
    const entityMcpInjectContext: boolean =
      entityRow?.mcpConfig?.injectMcpContext === true;

    for (const tool of tools) {
      const schemaHash = this.hashSchema(tool.paramSchema);
      const paramNames = this.extractParamNames(tool.paramSchema);
      const text = `${tool.name} ${tool.description} ${paramNames}`;
      const bm25Tokens = tokenize(text);

      // TL.1 — category inference for entity-registered tools.
      // Precedence:
      //   1. Author-declared `tool.category` (set via WS register frame
      //      annotations.category or top-level category).
      //   2. Dotted-prefix heuristic: `linear.create_issue` → `linear`,
      //      `slack.send_message` → `slack`. Anything before the first `.`.
      //   3. The source entity's slug (carries the "who owns this tool"
      //      signal even when the SDK didn't namespace the name).
      //   4. Literal `"entity"` as final fallback.
      // The computed value is only applied when no explicit category
      // reached us — we never override an author declaration.
      const resolvedCategory =
        tool.category || inferEntityToolCategory(tool.name, params.sourceEntityId);

      // Upsert into central registry.
      // SECURITY (audit H15) — scope the lookup + create to (org, project,
      // name). Previously the row was keyed by `name` alone (global @unique),
      // so an org registering a common tool name overwrote another org's shared
      // row and re-indexed the shared toolId in the process-wide BM25 index —
      // cross-tenant schema-overwrite + ranking poison. Each tenant now owns
      // its own row.
      let existing = await this.prisma.platosToolDefinition.findFirst({
        where: {
          name: tool.name,
          organizationId: params.organizationId,
          projectId: params.projectId,
        },
      });

      if (existing) {
        // Update if schema changed
        if (existing.schemaHash !== schemaHash) {
          await this.prisma.platosToolDefinition.update({
            where: { id: existing.id },
            data: {
              description: tool.description,
              paramSchema: tool.paramSchema,
              category: resolvedCategory || existing.category,
              schemaHash,
              bm25Tokens,
            },
          });
          this.bm25.addDocument(existing.id, text); // Re-index
          updated++;
        }
      } else {
        existing = await this.prisma.platosToolDefinition.create({
          data: {
            name: tool.name,
            organizationId: params.organizationId,
            projectId: params.projectId,
            description: tool.description,
            paramSchema: tool.paramSchema,
            category: resolvedCategory,
            schemaHash,
            bm25Tokens,
          },
        });
        this.bm25.addDocument(existing.id, text);
        newTools++;
      }

      // Upsert entity-tool mapping: unique by (toolId, entityId, environmentId)
      await this.prisma.platosEntityToolMapping.upsert({
        where: {
          toolId_entityId_environmentId: {
            toolId: existing.id,
            entityId: params.entityPk,
            environmentId: params.environmentId,
          },
        },
        update: { callbackUrl: callbackUrl ?? null, enabled: true },
        create: {
          toolId: existing.id,
          entityId: params.entityPk,
          environmentId: params.environmentId,
          callbackUrl: callbackUrl ?? null,
          enabled: true,
        },
      });

      // Update in-memory cache
      const cacheKey = `${params.organizationId}:${params.projectId}:${params.environmentId}:${params.sourceEntityId}`;
      if (!this.scopedToolCache.has(cacheKey)) {
        this.scopedToolCache.set(cacheKey, new Map());
      }
      this.scopedToolCache.get(cacheKey)!.set(tool.name, {
        toolId: existing.id,
        toolName: tool.name,
        description: tool.description,
        paramSchema: tool.paramSchema,
        category: resolvedCategory || null,
        // Same NULL→sentinel coercion as the rebuild-hydration path: mcp-kind
        // rows register with a null callback; keep the cached entry typed
        // `string` via the never-dereferenced "mcp:noop" sentinel. (design §1.3)
        callbackUrl: callbackUrl ?? "mcp:noop",
        sourceEntityId: params.sourceEntityId,
        entityPk: params.entityPk,
        enabled: true,
        linkedAgentIds,
        entityMcpInjectContext,
      });

      registered++;
    }

    return { registered, updated, newTools };
  }

  /**
   * Search for tools matching a query, scoped to a specific (org, project, env).
   * Uses BM25 for ranking, filters by scope + enabled. When sourceEntityId is
   * provided, results are further narrowed to that single entity.
   *
   * This is the implementation behind the agent's find_tools meta-tool.
   */
  findTools(
    query: string,
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    limit: number = 15,
    sourceEntityId?: string,
    agentId?: string,
  ): OrgToolEntry[] {
    const matchingEntries = this.collectScopedEntries(scope, sourceEntityId);
    if (matchingEntries.length === 0) return [];

    // Build toolId → first matching entry map and the enabled ID set for filtering.
    const enabledToolIds = new Set<string>();
    const entryByToolId = new Map<string, OrgToolEntry>();
    for (const entry of matchingEntries) {
      if (!entry.enabled) continue;
      if (!isVisibleToAgent(entry, agentId)) continue;
      enabledToolIds.add(entry.toolId);
      // Prefer the first occurrence; later entries for the same tool from other
      // entities within scope are still reachable via getScopedTools but we
      // only surface one per tool name here.
      if (!entryByToolId.has(entry.toolId)) entryByToolId.set(entry.toolId, entry);
    }

    // BM25 search filtered to enabled tools in this scope.
    const results = this.bm25.search(query, limit, enabledToolIds);
    return results
      .map((r) => entryByToolId.get(r.id) || null)
      .filter((e): e is OrgToolEntry => e !== null);
  }

  /**
   * Get all tools for a scope (optionally filtered to one entity and / or
   * to a specific agent via the per-entity `linkedAgentIds` allow-list).
   * Used for Mode 2 schema injection, the Tools tab mapping view, and the
   * find_tools meta-tool's backing call.
   */
  getScopedTools(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    options: { enabledOnly?: boolean; sourceEntityId?: string; agentId?: string } = {},
  ): OrgToolEntry[] {
    const enabledOnly = options.enabledOnly ?? true;
    const entries = this.collectScopedEntries(scope, options.sourceEntityId);
    const allowed = options.agentId
      ? entries.filter((e) => isVisibleToAgent(e, options.agentId))
      : entries;
    return enabledOnly ? allowed.filter((e) => e.enabled) : allowed;
  }

  /**
   * Propagate a change in `PlatosConnectedEntity.linkedAgentIds` into every
   * cached OrgToolEntry for that entity. Called by the entity PATCH handler
   * after the DB write so subsequent find_tools / getScopedTools calls see
   * the new allow-list without a full registry rebuild. Scope-scoped: only
   * entries whose entityPk matches are touched.
   */
  syncEntityLinkedAgents(entityPk: string, linkedAgentIds: string[]): number {
    const next = Array.isArray(linkedAgentIds) ? linkedAgentIds.slice() : [];
    let updated = 0;
    for (const bucket of this.scopedToolCache.values()) {
      for (const entry of bucket.values()) {
        if (entry.entityPk === entityPk) {
          entry.linkedAgentIds = next;
          updated++;
        }
      }
    }
    return updated;
  }

  /**
   * Enable or disable a tool for a specific (entity, environment).
   */
  async setToolEnabled(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    sourceEntityId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<boolean> {
    const key = scopeEntityKey(scope, sourceEntityId);
    const bucket = this.scopedToolCache.get(key);
    const entry = bucket?.get(toolName);
    if (!entry) return false;

    await this.prisma.platosEntityToolMapping.update({
      where: {
        toolId_entityId_environmentId: {
          toolId: entry.toolId,
          entityId: entry.entityPk,
          environmentId: scope.environmentId,
        },
      },
      data: { enabled },
    });

    entry.enabled = enabled;
    return true;
  }

  /**
   * Prune tools that a fresh discovery no longer reports for an
   * (entity, environment) pair. Discovery is idempotent-REPLACE:
   * `registerTools` is additive-upsert, so after re-registering the fresh set
   * this removes every `PlatosEntityToolMapping` row for tools that vanished
   * from the source (AC6). Single-env signature — `EntityMcpDiscoveryService`
   * loops it once per env, mirroring the per-env registration pass. (design §5)
   *
   * For each stale mapping it:
   *   1. deletes the `PlatosEntityToolMapping` row (this env only),
   *   2. evicts the tool from the scoped in-memory cache bucket, and
   *   3. removes the BM25 document ONLY if no mapping anywhere still references
   *      that `PlatosToolDefinition` (the definition + its BM25 doc are shared
   *      across entities/envs/orgs — a still-referenced doc must survive).
   *
   * The `PlatosToolDefinition` row itself is left intact — it is a shared,
   * tenant-scoped registry row that other mappings may still point at.
   */
  async reconcileEntityTools(
    entityPk: string,
    environmentId: string,
    freshToolNames: string[],
  ): Promise<{ removed: number }> {
    const fresh = new Set(freshToolNames);

    // Current mappings for this (entity, env), joined to the tool for its name.
    const mappings = await this.prisma.platosEntityToolMapping.findMany({
      where: { entityId: entityPk, environmentId },
      include: { tool: { select: { id: true, name: true } } },
    });
    const stale = mappings.filter(
      (m: any) => m.tool && !fresh.has(m.tool.name),
    );
    if (stale.length === 0) return { removed: 0 };

    // 1. Drop the mapping rows for this env.
    await this.prisma.platosEntityToolMapping.deleteMany({
      where: { id: { in: stale.map((m: any) => m.id) } },
    });

    // 2. Evict from the scoped cache. Rebuild the bucket key from the entity's
    //    (org, project, slug) + this env — the same key registerTools writes.
    const entity = await this.prisma.platosConnectedEntity.findFirst({
      where: { id: entityPk },
      select: { organizationId: true, projectId: true, entityId: true },
    });
    if (entity) {
      const key = `${entity.organizationId}:${entity.projectId}:${environmentId}:${entity.entityId}`;
      const bucket = this.scopedToolCache.get(key);
      if (bucket) {
        for (const m of stale) bucket.delete(m.tool.name);
        if (bucket.size === 0) this.scopedToolCache.delete(key);
      }
    }

    // 3. Remove each orphaned BM25 doc — but only when NO mapping anywhere still
    //    references the (shared) tool definition, so we never yank a doc another
    //    scope's find_tools still needs.
    for (const m of stale) {
      const remaining = await this.prisma.platosEntityToolMapping.count({
        where: { toolId: m.tool.id },
      });
      if (remaining === 0) this.bm25.removeDocument(m.tool.id);
    }

    return { removed: stale.length };
  }

  /**
   * Drop every trace of an entity from the registry: mappings, the in-memory
   * scoped-tool buckets across ALL environments, and any BM25 doc nothing else
   * references.
   *
   * THE DEFECT THIS EXISTS TO FIX
   *
   * `deleteEntity` was a bare `deleteMany` on PlatosConnectedEntity. The row
   * vanished; the cache did not. `scopedToolCache` is keyed by
   * (org, project, env, entityId) and only ever written — the sole delete in
   * this service lives in `reconcileEntityTools`, which the WebSocket path
   * never calls. So a deleted entity's tools kept being injected into every
   * turn, and dispatching one looked up `toolEntry.entityPk` against a row that
   * no longer existed and failed with "Entity <id> not registered".
   *
   * That is a bad failure to leave in place: the tools are advertised to the
   * model with full schemas, so the model reasonably calls them, and the user
   * sees a capability the agent claims and cannot perform. It also silently
   * inflates every prompt with dead schemas until the process restarts, which
   * is the only thing that ever cleared this.
   *
   * Takes the PK because entityId is only unique per (org, project), and the
   * caller has already resolved the row it is about to delete.
   */
  async purgeEntity(entityPk: string): Promise<{ mappingsRemoved: number; bucketsEvicted: number }> {
    const mappings = await this.prisma.platosEntityToolMapping.findMany({
      where: { entityId: entityPk },
      include: { tool: { select: { id: true, name: true } } },
    });

    // Resolve the cache-key parts before the row is gone. A purge called after
    // the entity row is deleted can still clean mappings and BM25, but cannot
    // rebuild the bucket key — so fall back to scanning buckets by entityPk.
    const entity = await this.prisma.platosConnectedEntity.findFirst({
      where: { id: entityPk },
      select: { organizationId: true, projectId: true, entityId: true },
    });

    if (mappings.length > 0) {
      await this.prisma.platosEntityToolMapping.deleteMany({
        where: { entityId: entityPk },
      });
    }

    // Evict every bucket owned by this entity. Keyed lookup when the row is
    // still present; otherwise identify buckets by the entityPk stamped on
    // their entries, which is what makes this safe to call in either order.
    let bucketsEvicted = 0;
    for (const [key, bucket] of this.scopedToolCache.entries()) {
      const ownedByKey =
        entity !== null &&
        key.startsWith(`${entity.organizationId}:${entity.projectId}:`) &&
        key.endsWith(`:${entity.entityId}`);
      const ownedByEntry = [...bucket.values()].some((e) => e.entityPk === entityPk);
      if (ownedByKey || ownedByEntry) {
        this.scopedToolCache.delete(key);
        bucketsEvicted++;
      }
    }

    // Drop BM25 docs for definitions nothing else points at. The definition row
    // itself is shared and tenant-scoped, so it stays — same rule as reconcile.
    for (const m of mappings) {
      if (!m.tool) continue;
      const remaining = await this.prisma.platosEntityToolMapping.count({
        where: { toolId: m.tool.id },
      });
      if (remaining === 0) this.bm25.removeDocument(m.tool.id);
    }

    return { mappingsRemoved: mappings.length, bucketsEvicted };
  }

  /**
   * Get BM25 index stats (for monitoring dashboard).
   */
  getIndexStats() {
    return {
      ...this.bm25.getStats(),
      cachedScopeEntityPairs: this.scopedToolCache.size,
    };
  }

  private collectScopedEntries(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    sourceEntityId?: string,
  ): OrgToolEntry[] {
    if (sourceEntityId) {
      const bucket = this.scopedToolCache.get(scopeEntityKey(scope, sourceEntityId));
      if (!bucket) return [];
      return Array.from(bucket.values());
    }
    const prefix = scopePrefix(scope);
    const out: OrgToolEntry[] = [];
    for (const [key, bucket] of this.scopedToolCache.entries()) {
      if (!key.startsWith(prefix)) continue;
      out.push(...bucket.values());
    }
    return out;
  }

  private hashSchema(schema: Record<string, unknown>): string {
    return crypto.createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16);
  }

  private extractParamNames(schema: Record<string, unknown>): string {
    if (!schema || typeof schema !== "object") return "";
    const props = (schema as any).properties;
    if (!props || typeof props !== "object") return "";
    return Object.keys(props).join(" ");
  }
}

/**
 * TL.1 — infer a category for an entity-registered tool when the SDK did
 * not declare one explicitly. Pure + exported so future TL.1.1 (per-tool
 * category in WS register) can share the fallback chain. Rules:
 *   1. Dotted prefix wins: `linear.create_issue` → `linear`.
 *   2. Otherwise fall back to the source entity's slug.
 *   3. Literal `"entity"` as the final floor so Tools tab always has
 *      something to render.
 */
export function inferEntityToolCategory(
  toolName: string,
  sourceEntityId: string,
): string {
  const name = (toolName || "").trim();
  if (name.includes(".")) {
    const prefix = name.split(".", 1)[0]?.trim();
    if (prefix) return prefix;
  }
  const slug = (sourceEntityId || "").trim();
  if (slug) return slug;
  return "entity";
}
