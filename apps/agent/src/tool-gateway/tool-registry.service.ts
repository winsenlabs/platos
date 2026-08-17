import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { PolicyEffect, ToolKind } from "@platos/database";
import * as crypto from "node:crypto";
import type { RequestScope } from "../auth/scope.guard";
import {
  PRISMA_TOKEN,
  type ControlDatabaseClient,
} from "../shared/database.provider";
import { BM25Index } from "./bm25";

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
  sourceEntityId: string;
  entityPk: string;
  environmentId: string;
  enabled: boolean;
  dispatchable: boolean;
  connectionKind: string;
  /** Agent IDs whose active Environment binding permits this tool. */
  allowedAgentIds: string[];
  entityMcpInjectContext: boolean;
}

type ScopeTuple = Pick<
  RequestScope,
  "organizationId" | "projectId" | "environmentId"
>;

type AgentPolicyBinding = {
  agentId: string;
  activeAgentVersion: {
    toolDefaultPolicy: "NONE" | "ALL";
    toolPolicies: Array<{ toolId: string; effect: PolicyEffect }>;
  };
};

function scopeEntityKey(scope: ScopeTuple, sourceEntityId: string): string {
  return `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${sourceEntityId}`;
}

function scopePrefix(scope: ScopeTuple): string {
  return `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:`;
}

function isVisibleToAgent(entry: OrgToolEntry, agentId?: string): boolean {
  return !agentId || entry.allowedAgentIds.includes(agentId);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function entryOrder(a: OrgToolEntry, b: OrgToolEntry): number {
  return (
    a.toolName.localeCompare(b.toolName) ||
    a.sourceEntityId.localeCompare(b.sourceEntityId) ||
    a.toolId.localeCompare(b.toolId)
  );
}

/**
 * Central Tool registry plus the Environment/Entity dispatch matrix.
 *
 * Persisted Tool rows are immutable schema versions. A registration replaces
 * the complete EnvironmentEntityTool declaration for one (Environment, Entity)
 * pair, then replaces the corresponding cache bucket and rebuilds BM25 only
 * from dispatchable cached mappings. The cache and index therefore shrink on
 * registration, deletion, and rebuild instead of accumulating historical rows.
 */
@Injectable()
export class ToolRegistryService implements OnModuleInit {
  private readonly bm25 = new BM25Index();
  private readonly scopedToolCache = new Map<
    string,
    Map<string, OrgToolEntry>
  >();

  constructor(
    @Inject(PRISMA_TOKEN)
    private readonly prisma: ControlDatabaseClient,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rebuildIndex();
  }

  /** Replace the complete in-memory registry from clean tenancy rows. */
  async rebuildIndex(): Promise<void> {
    const mappings = await this.prisma.environmentEntityTool.findMany({
      include: {
        tool: true,
        entity: {
          include: {
            project: { select: { organizationId: true } },
            mcpConfig: { select: { injectMcpContext: true } },
            mcpClient: { select: { transport: true, url: true } },
          },
        },
        environment: { select: { projectId: true } },
      },
      orderBy: [
        { environmentId: "asc" },
        { entityId: "asc" },
        { tool: { name: "asc" } },
        { toolId: "asc" },
      ],
    });

    const environmentIds = [...new Set(mappings.map((row) => row.environmentId))];
    const bindingsByEnvironment = new Map<string, AgentPolicyBinding[]>();
    if (environmentIds.length > 0) {
      const bindings = await this.prisma.agentBinding.findMany({
        where: { environmentId: { in: environmentIds } },
        select: {
          environmentId: true,
          agentId: true,
          activeAgentVersion: {
            select: {
              toolDefaultPolicy: true,
              toolPolicies: { select: { toolId: true, effect: true } },
            },
          },
        },
        orderBy: [{ environmentId: "asc" }, { agentId: "asc" }],
      });
      for (const binding of bindings) {
        const bucket = bindingsByEnvironment.get(binding.environmentId) ?? [];
        bucket.push(binding as AgentPolicyBinding);
        bindingsByEnvironment.set(binding.environmentId, bucket);
      }
    }

    const next = new Map<string, Map<string, OrgToolEntry>>();
    for (const mapping of mappings) {
      const { entity, environment, tool } = mapping;
      if (entity.projectId !== environment.projectId) continue;

      const scope: ScopeTuple = {
        organizationId: entity.project.organizationId,
        projectId: entity.projectId,
        environmentId: mapping.environmentId,
      };
      const key = scopeEntityKey(scope, entity.externalId);
      const bucket = next.get(key) ?? new Map<string, OrgToolEntry>();
      const dispatchable = this.isPersistedMappingDispatchable({
        connectionKind: entity.connectionKind,
        callbackUrl: mapping.callbackUrl,
        hasMcpClient: entity.mcpClient !== null,
      });
      bucket.set(
        tool.name,
        this.toEntry(
          mapping,
          bindingsByEnvironment.get(mapping.environmentId) ?? [],
          dispatchable,
        ),
      );
      next.set(key, bucket);
    }

    this.scopedToolCache.clear();
    for (const [key, bucket] of [...next.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      this.scopedToolCache.set(key, bucket);
    }
    this.rebuildSearchIndex();

    const stats = this.bm25.getStats();
    console.log(
      `[Platos ToolRegistry] Index rebuilt: ${stats.totalDocs} dispatchable tools, ` +
        `${stats.uniqueTerms} terms, ${this.scopedToolCache.size} (scope,entity) buckets`,
    );
  }

  /**
   * Declaratively replace one entity's complete tool declaration in an
   * Environment. Tool rows are immutable content-addressed schema versions;
   * mappings are the tenancy-owned mutable exposure state.
   */
  async registerTools(
    params: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      entityPk: string;
      sourceEntityId: string;
    },
    tools: ToolSchema[],
    callbackUrl?: string | null,
  ): Promise<{
    registered: number;
    updated: number;
    newTools: number;
    removed: number;
  }> {
    const entity = await this.prisma.entity.findFirst({
      where: {
        id: params.entityPk,
        externalId: params.sourceEntityId,
        projectId: params.projectId,
        project: { organizationId: params.organizationId },
      },
      select: {
        id: true,
        externalId: true,
        connectionKind: true,
        mcpConfig: { select: { injectMcpContext: true } },
        mcpClient: { select: { entityId: true } },
      },
    });
    if (!entity) throw new Error("entity_not_found_in_scope");

    const environment = await this.prisma.environment.findFirst({
      where: {
        id: params.environmentId,
        projectId: params.projectId,
        project: { organizationId: params.organizationId },
      },
      select: { id: true },
    });
    if (!environment) throw new Error("environment_not_found_in_scope");

    const declaration = this.normalizeDeclaration(tools, params.sourceEntityId);
    const previous = await this.prisma.environmentEntityTool.findMany({
      where: {
        environmentId: params.environmentId,
        entityId: params.entityPk,
      },
      select: { id: true, toolId: true, tool: { select: { name: true } } },
    });
    const previousToolIds = new Set(previous.map((row) => row.toolId));

    const persisted = await this.prisma.$transaction(async (tx) => {
      const activeMappingIds: string[] = [];
      const rows: Array<{
        mapping: {
          id: string;
          environmentId: string;
          entityId: string;
          toolId: string;
          enabled: boolean;
          callbackUrl: string | null;
        };
        tool: {
          id: string;
          name: string;
          description: string;
          paramSchema: unknown;
          category: string | null;
          schemaHash: string;
        };
      }> = [];

      for (const item of declaration) {
        const tool = await tx.tool.upsert({
          where: {
            name_schemaHash: {
              name: item.name,
              schemaHash: item.schemaHash,
            },
          },
          update: {},
          create: {
            name: item.name,
            description: item.description,
            kind: ToolKind.ENTITY,
            paramSchema: item.paramSchema as never,
            category: item.category,
            schemaHash: item.schemaHash,
          },
        });
        const mapping = await tx.environmentEntityTool.upsert({
          where: {
            environmentId_entityId_toolId: {
              environmentId: params.environmentId,
              entityId: params.entityPk,
              toolId: tool.id,
            },
          },
          update: { callbackUrl: callbackUrl ?? null, enabled: true },
          create: {
            environmentId: params.environmentId,
            entityId: params.entityPk,
            toolId: tool.id,
            callbackUrl: callbackUrl ?? null,
            enabled: true,
          },
        });
        activeMappingIds.push(mapping.id);
        rows.push({ mapping, tool });
      }

      await tx.environmentEntityTool.deleteMany({
        where: {
          environmentId: params.environmentId,
          entityId: params.entityPk,
          ...(activeMappingIds.length > 0
            ? { id: { notIn: activeMappingIds } }
            : {}),
        },
      });
      return rows;
    });

    const bindings = await this.loadAgentPolicyBindings(params.environmentId);
    const cacheKey = scopeEntityKey(params, params.sourceEntityId);
    const bucket = new Map<string, OrgToolEntry>();
    for (const { mapping, tool } of persisted) {
      bucket.set(
        tool.name,
        {
          toolId: tool.id,
          toolName: tool.name,
          description: tool.description,
          paramSchema: tool.paramSchema as Record<string, unknown>,
          category: tool.category,
          callbackUrl: mapping.callbackUrl ?? "",
          sourceEntityId: entity.externalId,
          entityPk: entity.id,
          environmentId: mapping.environmentId,
          enabled: mapping.enabled,
          dispatchable: true,
          connectionKind: entity.connectionKind,
          allowedAgentIds: this.allowedAgentIds(tool.id, bindings),
          entityMcpInjectContext:
            entity.mcpConfig?.injectMcpContext === true,
        },
      );
    }
    if (bucket.size > 0) this.scopedToolCache.set(cacheKey, bucket);
    else this.scopedToolCache.delete(cacheKey);
    this.rebuildSearchIndex();

    const activeToolIds = new Set(persisted.map(({ tool }) => tool.id));
    const newTools = [...activeToolIds].filter(
      (toolId) => !previousToolIds.has(toolId),
    ).length;
    const updated = persisted.length - newTools;
    const activeNames = new Set(declaration.map((tool) => tool.name));
    const removed = previous.filter((mapping) => !activeNames.has(mapping.tool.name)).length;
    return { registered: persisted.length, updated, newTools, removed };
  }

  findTools(
    query: string,
    scope: ScopeTuple,
    limit = 15,
    sourceEntityId?: string,
    agentId?: string,
  ): OrgToolEntry[] {
    const entries = this.collectScopedEntries(scope, sourceEntityId).filter(
      (entry) =>
        entry.enabled &&
        entry.dispatchable &&
        isVisibleToAgent(entry, agentId),
    );
    if (entries.length === 0) return [];

    const enabledToolIds = new Set(entries.map((entry) => entry.toolId));
    const entryByToolId = new Map<string, OrgToolEntry>();
    for (const entry of entries) {
      if (!entryByToolId.has(entry.toolId)) {
        entryByToolId.set(entry.toolId, entry);
      }
    }
    return this.bm25
      .search(query, limit, enabledToolIds)
      .map((result) => entryByToolId.get(result.id))
      .filter((entry): entry is OrgToolEntry => entry !== undefined);
  }

  getScopedTools(
    scope: ScopeTuple,
    options: {
      enabledOnly?: boolean;
      sourceEntityId?: string;
      agentId?: string;
    } = {},
  ): OrgToolEntry[] {
    const enabledOnly = options.enabledOnly ?? true;
    return this.collectScopedEntries(scope, options.sourceEntityId).filter(
      (entry) =>
        isVisibleToAgent(entry, options.agentId) &&
        (!enabledOnly || (entry.enabled && entry.dispatchable)),
    );
  }

  /**
   * Retained as a temporary caller-boundary shim while entity mutation moves to
   * AgentToolPolicy. It intentionally does not recreate the retired entity
   * allowlist; a registry rebuild reloads canonical policy rows.
   */
  syncEntityLinkedAgents(_entityPk: string, _linkedAgentIds: string[]): number {
    return 0;
  }

  /**
   * Explicit invalidation path for AgentToolPolicy/default-policy mutations.
   * Agent version activation/rollback callers invoke this after commit so
   * direct schemas and find_tools observe the same policy revision.
   */
  async refreshEnvironmentPolicies(scope: ScopeTuple): Promise<number> {
    const environment = await this.prisma.environment.findFirst({
      where: {
        id: scope.environmentId,
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
      select: { id: true },
    });
    if (!environment) return 0;

    const bindings = await this.loadAgentPolicyBindings(scope.environmentId);
    const prefix = scopePrefix(scope);
    let updated = 0;
    for (const [key, bucket] of this.scopedToolCache) {
      if (!key.startsWith(prefix)) continue;
      for (const entry of bucket.values()) {
        entry.allowedAgentIds = this.allowedAgentIds(entry.toolId, bindings);
        updated += 1;
      }
    }
    return updated;
  }

  async setToolEnabled(
    scope: ScopeTuple,
    sourceEntityId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<boolean> {
    const bucket = this.scopedToolCache.get(scopeEntityKey(scope, sourceEntityId));
    const entry = bucket?.get(toolName);
    if (!entry) return false;

    await this.prisma.environmentEntityTool.update({
      where: {
        environmentId_entityId_toolId: {
          environmentId: scope.environmentId,
          entityId: entry.entityPk,
          toolId: entry.toolId,
        },
      },
      data: { enabled },
    });
    entry.enabled = enabled;
    this.rebuildSearchIndex();
    return true;
  }

  /** Idempotent compatibility entry point; registration already replaces. */
  async reconcileEntityTools(
    entityPk: string,
    environmentId: string,
    freshToolNames: string[],
  ): Promise<{ removed: number }> {
    const fresh = new Set(freshToolNames);
    const mappings = await this.prisma.environmentEntityTool.findMany({
      where: { entityId: entityPk, environmentId },
      include: { tool: { select: { name: true } } },
    });
    const stale = mappings.filter((mapping) => !fresh.has(mapping.tool.name));
    if (stale.length === 0) return { removed: 0 };

    await this.prisma.environmentEntityTool.deleteMany({
      where: { id: { in: stale.map((mapping) => mapping.id) } },
    });
    for (const [key, bucket] of this.scopedToolCache) {
      let changed = false;
      for (const mapping of stale) {
        const entry = bucket.get(mapping.tool.name);
        if (entry?.entityPk === entityPk) {
          bucket.delete(mapping.tool.name);
          changed = true;
        }
      }
      if (changed && bucket.size === 0) this.scopedToolCache.delete(key);
    }
    this.rebuildSearchIndex();
    return { removed: stale.length };
  }

  async purgeEntity(
    entityPk: string,
  ): Promise<{ mappingsRemoved: number; bucketsEvicted: number }> {
    const removed = await this.prisma.environmentEntityTool.deleteMany({
      where: { entityId: entityPk },
    });
    let bucketsEvicted = 0;
    for (const [key, bucket] of this.scopedToolCache) {
      if ([...bucket.values()].some((entry) => entry.entityPk === entityPk)) {
        this.scopedToolCache.delete(key);
        bucketsEvicted += 1;
      }
    }
    this.rebuildSearchIndex();
    return { mappingsRemoved: removed.count, bucketsEvicted };
  }

  /** Update transport liveness and immediately invalidate search/exposure. */
  setEntityDispatchable(
    entityPk: string,
    dispatchable: boolean,
    environmentId?: string,
  ): number {
    let updated = 0;
    for (const bucket of this.scopedToolCache.values()) {
      for (const entry of bucket.values()) {
        if (
          entry.entityPk !== entityPk ||
          (environmentId && entry.environmentId !== environmentId)
        ) {
          continue;
        }
        const next = dispatchable || this.hasPersistentCallback(entry.callbackUrl);
        if (entry.dispatchable !== next) {
          entry.dispatchable = next;
          updated += 1;
        }
      }
    }
    if (updated > 0) this.rebuildSearchIndex();
    return updated;
  }

  getIndexStats() {
    return {
      ...this.bm25.getStats(),
      cachedScopeEntityPairs: this.scopedToolCache.size,
    };
  }

  private async loadAgentPolicyBindings(
    environmentId: string,
  ): Promise<AgentPolicyBinding[]> {
    return (await this.prisma.agentBinding.findMany({
      where: { environmentId },
      select: {
        agentId: true,
        activeAgentVersion: {
          select: {
            toolDefaultPolicy: true,
            toolPolicies: { select: { toolId: true, effect: true } },
          },
        },
      },
      orderBy: { agentId: "asc" },
    })) as AgentPolicyBinding[];
  }

  private allowedAgentIds(
    toolId: string,
    bindings: AgentPolicyBinding[],
  ): string[] {
    const allowed: string[] = [];
    for (const binding of bindings) {
      const explicit = binding.activeAgentVersion.toolPolicies.find(
        (policy) => policy.toolId === toolId,
      );
      if (
        explicit?.effect === PolicyEffect.ALLOW ||
        (!explicit && binding.activeAgentVersion.toolDefaultPolicy === "ALL")
      ) {
        allowed.push(binding.agentId);
      }
    }
    return allowed.sort();
  }

  private normalizeDeclaration(
    tools: ToolSchema[],
    sourceEntityId: string,
  ): Array<ToolSchema & { category: string; schemaHash: string }> {
    const byName = new Map<string, ToolSchema & { category: string; schemaHash: string }>();
    for (const raw of tools) {
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      if (!name) throw new Error("tool_name_required");
      if (byName.has(name)) throw new Error(`duplicate_tool_name:${name}`);
      const description = typeof raw.description === "string" ? raw.description : "";
      const paramSchema =
        raw.paramSchema && typeof raw.paramSchema === "object"
          ? raw.paramSchema
          : {};
      const category =
        raw.category?.trim() || inferEntityToolCategory(name, sourceEntityId);
      const schemaHash = crypto
        .createHash("sha256")
        .update(stableJson({ name, description, paramSchema, category }))
        .digest("hex")
        .slice(0, 16);
      byName.set(name, {
        name,
        description,
        paramSchema,
        category,
        schemaHash,
      });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private toEntry(
    mapping: {
      environmentId: string;
      toolId: string;
      enabled: boolean;
      callbackUrl: string | null;
      tool: {
        name: string;
        description: string;
        paramSchema: unknown;
        category: string | null;
      };
      entity: {
        id: string;
        externalId: string;
        connectionKind: string;
        mcpConfig: { injectMcpContext: boolean } | null;
      };
    },
    bindings: AgentPolicyBinding[],
    dispatchable: boolean,
  ): OrgToolEntry {
    return {
      toolId: mapping.toolId,
      toolName: mapping.tool.name,
      description: mapping.tool.description,
      paramSchema: mapping.tool.paramSchema as Record<string, unknown>,
      category: mapping.tool.category,
      callbackUrl: mapping.callbackUrl ?? "",
      sourceEntityId: mapping.entity.externalId,
      entityPk: mapping.entity.id,
      environmentId: mapping.environmentId,
      enabled: mapping.enabled,
      dispatchable,
      connectionKind: mapping.entity.connectionKind,
      allowedAgentIds: this.allowedAgentIds(mapping.toolId, bindings),
      entityMcpInjectContext:
        mapping.entity.mcpConfig?.injectMcpContext === true,
    };
  }

  private collectScopedEntries(
    scope: ScopeTuple,
    sourceEntityId?: string,
  ): OrgToolEntry[] {
    if (sourceEntityId) {
      return [...(this.scopedToolCache.get(scopeEntityKey(scope, sourceEntityId))?.values() ?? [])]
        .sort(entryOrder);
    }
    const prefix = scopePrefix(scope);
    const entries: OrgToolEntry[] = [];
    for (const [key, bucket] of this.scopedToolCache) {
      if (key.startsWith(prefix)) entries.push(...bucket.values());
    }
    return entries.sort(entryOrder);
  }

  private rebuildSearchIndex(): void {
    this.bm25.clear();
    const indexed = new Set<string>();
    const entries = [...this.scopedToolCache.values()]
      .flatMap((bucket) => [...bucket.values()])
      .filter((entry) => entry.enabled && entry.dispatchable)
      .sort(entryOrder);
    for (const entry of entries) {
      if (indexed.has(entry.toolId)) continue;
      indexed.add(entry.toolId);
      this.bm25.addDocument(
        entry.toolId,
        `${entry.toolName} ${entry.description} ${this.extractParamNames(entry.paramSchema)}`,
      );
    }
  }

  private isPersistedMappingDispatchable(input: {
    connectionKind: string;
    callbackUrl: string | null;
    hasMcpClient: boolean;
  }): boolean {
    if (input.connectionKind === "mcp") return input.hasMcpClient;
    return this.hasPersistentCallback(input.callbackUrl ?? "");
  }

  private hasPersistentCallback(callbackUrl: string): boolean {
    return /^https?:\/\//i.test(callbackUrl);
  }

  private extractParamNames(schema: Record<string, unknown>): string {
    const props = schema?.properties;
    if (!props || typeof props !== "object" || Array.isArray(props)) return "";
    return Object.keys(props).sort().join(" ");
  }
}

export function inferEntityToolCategory(
  toolName: string,
  sourceEntityId: string,
): string {
  const name = (toolName || "").trim();
  if (name.includes(".")) {
    const prefix = name.split(".", 1)[0]?.trim();
    if (prefix) return prefix;
  }
  return (sourceEntityId || "").trim() || "entity";
}
