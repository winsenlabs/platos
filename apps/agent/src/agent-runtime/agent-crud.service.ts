import { Injectable, Inject, Optional } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "../auth/scope.guard";
import { AdminAuditService } from "../monitoring/admin-audit.service";
import { serializePromptBlocksToSystemPrompt } from "./prompt-builder.service";

export interface PromptBlock {
  id: string;
  type: string;
  name: string;
  content: string;
  enabled: boolean;
  editable: boolean;
  order: number;
}

export interface DynamicBlockTemplate {
  key: string;
  name: string;
  defaultContent: string;
  description?: string;
  order?: number;
}

/**
 * TL.2 — display-mode keys. Drives how the main-LLM's tool layer is
 * rendered each turn. Values map 1:1 to `buildMetaTools()` branches:
 *
 *   full      — every enabled tool's full JSON Schema visible (current).
 *   summary   — no tool schemas (meta-tools only); a system-prompt
 *               addendum lists category -> tool count so the LLM can
 *               still reach specific tools via `find_tools` + `execute_tools`.
 *   meta-tool — only meta-tools, no category hint block. Pure discovery
 *               mode (this is effectively what sub-agent mode already does).
 *   hybrid    — union of `pinnedTools` (full schemas), meta-tools, and
 *               the summary block. For "always-on" essentials + long
 *               tail via discovery.
 *
 * `"full"` is the fallback for unknown / missing values so legacy rows
 * keep their current behavior end-to-end.
 */
export type ToolDisplayMode = "full" | "summary" | "meta-tool" | "hybrid";

export interface ToolsBlockConfig {
  /**
   * Execution mode — untouched by TL.2. Governs whether the parent LLM
   * calls tools directly, through a sub-agent, or via execute_tools only.
   */
  mode: "direct" | "sub-agent" | "execute-tool";
  enabledTools: string[];
  perToolPerms?: Record<string, { requiresApproval?: boolean; destructive?: boolean }>;
  /**
   * TL.2 — display-mode for the tool layer. See `ToolDisplayMode`.
   * Defaults to `"full"` when undefined / malformed.
   */
  displayMode?: ToolDisplayMode;
  /**
   * TL.2 — list of tool names pinned in full-schema form when
   * `displayMode === "hybrid"`. Ignored for other modes. Unknown names
   * are skipped silently at runtime (no guardrail here — the UI is the
   * enforcement point).
   */
  pinnedTools?: string[];
  /**
   * TL.2 — category filter applied BEFORE display-mode routing.
   *   - `null` / `undefined` → all categories visible (current behavior).
   *   - `[]` empty array     → no entity tools visible (meta-tools still pass).
   *   - `["email","calendar"]` → matrix narrowed to those categories.
   *
   * Meta-tools are always passthrough — their category ("memory" /
   * "discovery" / "orchestration" / …) is informational only and
   * toggled via the separate `metaTools` map.
   */
  enabledCategories?: string[] | null;
  /**
   * TL.3 hook — custom renderings per category id for the summary block.
   * `{ [categoryId]: { description?: string } }`. TL.2 reads the
   * `description` field when rendering; TL.3 will extend this shape.
   */
  categoryDescriptions?: Record<string, { description?: string }>;
  /**
   * PIFSP-11 — entity_ids mandate. When true, every turn on this agent
   * MUST carry an `entity_ids` list on the per-turn sessionContext (key
   * name configurable via `contextMapping.entityIdsKey`, default
   * `"entity_ids"`). Turns missing it error out with
   * `ENTITY_IDS_REQUIRED` before `buildMetaTools` runs — no prompt
   * assembly, no LLM call, no partial state.
   *
   * `undefined` is the auto-derive default: the runtime checks the number
   * of entities with at least one tool visible to this agent and treats
   * `mandated = linkedEntityCount > 1`. Explicit `true` / `false` lets
   * operators override the default either way (e.g. single-tenant agents
   * who want the safety net; multi-entity agents during a staged rollout
   * who want the legacy permissive behaviour).
   */
  entityIdsRequired?: boolean;
}

/**
 * A single named model route on an agent. Operators define a label
 * ("alpha", "bravo", "fast", "smart") and map it to a specific
 * (model, providerKeyId) pair. Callers select the label per-request;
 * the runtime resolves the actual model + key.
 */
export interface ModelRoute {
  /** Operator-defined label, e.g. "alpha", "bravo", "fast". */
  label: string;
  /** Full model string, e.g. "anthropic:claude-opus-4-7". */
  model: string;
  /** Optional PlatosProviderKey.id pin; null = use scope default key for this model's provider. */
  providerKeyId?: string | null;
  /** Exactly one route per agent should be the default (used when no label is specified). */
  isDefault: boolean;
}

export interface SubAgentConfig {
  model: string;
  maxSteps?: number;
  systemPrompt?: string;
  /** PIFSP-8 — "direct": inject full tool schemas; "meta-tool": find_tools+execute_tools (default). */
  toolMode?: "direct" | "meta-tool";
  /** PIFSP-8 — whether to apply Platos-side Redis prompt-prefix caching (default: true). */
  promptCaching?: boolean;
}

export interface ExtractionPolicyInput {
  enabled?: boolean;
  kinds?: Array<"fact" | "preference" | "event" | "relationship">;
  confidenceThreshold?: number;
  maxPerSession?: number;
  minMessagesBeforeRun?: number;
}

export interface CreateAgentDto {
  name: string;
  slug?: string;
  model: string;
  /** Per-request model routing table. When provided, replaces single-model config. */
  modelRoutes?: ModelRoute[];
  systemPrompt?: string;
  promptBlocks?: PromptBlock[];
  dynamicBlocks?: DynamicBlockTemplate[];
  maxSteps?: number;
  contextLimit?: number;
  historyMode?: "rolling" | "compact";
  compactThreshold?: number;
  enableUserProfiling?: boolean;
  toolMode?: string;
  toolsBlockConfig?: ToolsBlockConfig;
  subAgentConfig?: SubAgentConfig;
  memoryConfig?: Record<string, unknown>;
  metaTools?: Record<string, boolean>;
  /**
   * Theme F.5 — agent-level default output schema (JSON Schema). When set,
   * every turn on this agent is routed through structured-output mode
   * unless the request overrides with its own schema.
   */
  outputSchema?: Record<string, unknown> | null;
  /**
   * Theme O.2 — per-agent automatic memory extraction policy. Null / unset
   * means "enabled with defaults" — see MemoryExtractionService.
   */
  extractionPolicy?: ExtractionPolicyInput | null;
}

export interface UpdateAgentDto {
  name?: string;
  model?: string;
  systemPrompt?: string;
  promptBlocks?: PromptBlock[];
  dynamicBlocks?: DynamicBlockTemplate[];
  maxSteps?: number;
  contextLimit?: number;
  historyMode?: "rolling" | "compact";
  compactThreshold?: number;
  enableUserProfiling?: boolean;
  enableThreading?: boolean;
  threadingConfig?: Record<string, unknown> | null;
  /** PRA-AC: cluster membership. null = remove from cluster. */
  clusteringId?: string | null;
  toolMode?: string;
  toolsBlockConfig?: ToolsBlockConfig;
  subAgentConfig?: SubAgentConfig;
  memoryConfig?: Record<string, unknown>;
  metaTools?: Record<string, boolean>;
  isActive?: boolean;
  featureFlags?: Record<string, boolean>;
  /**
   * Theme F.5 — update the agent-level default output schema. Pass `null`
   * to clear; undefined to leave unchanged.
   */
  outputSchema?: Record<string, unknown> | null;
  /**
   * Theme O.2 — update the memory extraction policy. Pass `null` to clear
   * (falls back to defaults); undefined to leave unchanged.
   */
  extractionPolicy?: ExtractionPolicyInput | null;
  /**
   * Theme CTX.1 / CTX.6 — session-context mapping JSON. Extended shape in
   * CTX.6 adds `declaredKeys`, `constants`, and the `_auto` / `_global` /
   * `CONSTANT:` conventions inside `toolArgInjection`. Persisted verbatim
   * on PlatosAgent.contextMapping (Json column) — schema validation runs at
   * read time in the runtime resolver, not here, so UIs can save partial
   * drafts without the runtime choking.
   */
  contextMapping?: Record<string, unknown> | null;
  /**
   * PIFSP-14 — per-agent provider key pin. When set, the runtime uses this
   * specific PlatosProviderKey (instead of the scope default) for LLM calls.
   * Pass `null` to clear the pin; `undefined` to leave unchanged.
   */
  providerKeyId?: string | null;
  /**
   * Per-request model routing table. Pass an array to set routes; pass `null`
   * to clear and revert to the legacy single-model config; `undefined` leaves unchanged.
   */
  modelRoutes?: ModelRoute[] | null;
  /**
   * Theme G — note the user attaches to the version snapshot created on save.
   * Not persisted on `PlatosAgent`; forwarded to `PlatosAgentVersion.note`.
   */
  versionNote?: string;
}

/**
 * Theme G — shape of a single PlatosAgentVersion snapshot row.
 *
 * `snapshot` captures every user-editable agent config field at save time.
 * The diff UI (G.3) JSON-diffs two snapshots; rollback (G.4) copies an older
 * snapshot back onto PlatosAgent and flips `currentVersionId`.
 */
export interface AgentVersionSnapshot {
  model: string;
  /** Captured in every version so rollback restores the full routing table. */
  modelRoutes?: ModelRoute[] | null;
  systemPrompt: string | null;
  promptBlocks: PromptBlock[] | null;
  dynamicBlocks: DynamicBlockTemplate[] | null;
  maxSteps: number;
  contextLimit: number;
  historyMode: string;
  compactThreshold: number;
  enableUserProfiling: boolean;
  toolMode: string;
  toolsBlockConfig: ToolsBlockConfig | null;
  subAgentConfig: SubAgentConfig | null;
  memoryConfig: Record<string, unknown> | null;
  metaTools: Record<string, boolean> | null;
  featureFlags: Record<string, boolean> | null;
  /**
   * Theme F.5 — captured in the version snapshot so rollback restores the
   * exact structured-output schema the agent was serving at save time.
   */
  outputSchema: Record<string, unknown> | null;
  /**
   * Theme O.2 — captured in the version snapshot so rollback restores the
   * extraction policy that was live at save time.
   */
  extractionPolicy: Record<string, unknown> | null;
  /** PRA-TC — captured so rollback restores the threading state that was live at save time. */
  enableThreading: boolean;
  threadingConfig: Record<string, unknown> | null;
}

export interface AgentVersionRecord {
  id: string;
  agentId: string;
  versionNumber: number;
  createdBy: string;
  note: string | null;
  snapshot: AgentVersionSnapshot;
  createdAt: Date;
  isCurrent?: boolean;
  isCanary?: boolean;
}

export interface AgentRecord {
  id: string;
  name: string;
  slug: string;
  model: string;
  systemPrompt: string | null;
  promptBlocks: PromptBlock[] | null;
  dynamicBlocks: DynamicBlockTemplate[] | null;
  maxSteps: number;
  contextLimit: number;
  historyMode: string;
  compactThreshold: number;
  enableUserProfiling: boolean;
  toolMode: string;
  toolsBlockConfig: ToolsBlockConfig | null;
  subAgentConfig: SubAgentConfig | null;
  memoryConfig: Record<string, unknown> | null;
  metaTools: Record<string, boolean> | null;
  featureFlags: Record<string, boolean> | null;
  isActive: boolean;
  organizationId: string;
  projectId: string;
  environmentId: string;
  currentVersionId: string | null;
  canaryVersionId: string | null;
  canaryPercent: number;
  /**
   * Theme F.5 — agent-level default output schema (JSON Schema object).
   * Null / undefined = free-form text response, no schema enforcement.
   */
  outputSchema?: Record<string, unknown> | null;
  /**
   * Theme O.2 — per-agent memory extraction policy. Null means "enabled
   * with defaults" (see MemoryExtractionService.DEFAULT_EXTRACTION_POLICY).
   */
  extractionPolicy?: Record<string, unknown> | null;
  /**
   * Theme CTX.1 / CTX.6 — session-context mapping JSON. Opaque passthrough
   * here (runtime validates at read time); consumers cast to the CTX.6
   * `AgentContextMapping` shape.
   */
  contextMapping?: Record<string, unknown> | null;
  /** PIFSP-14 — pinned provider key id (null = use scope default). */
  providerKeyId?: string | null;
  /** Per-request model routing table. Null = use legacy single-model config. */
  modelRoutes?: ModelRoute[] | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { threads: number };
}

/**
 * AgentCrudService — full CRUD for PlatosAgent records.
 * All operations scoped by (organizationId, projectId, environmentId).
 */
@Injectable()
export class AgentCrudService {
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    @Optional() private readonly adminAudit?: AdminAuditService,
    // PIFSP-8 — invalidate Layer-1 prompt cache on agent save/update.
    @Optional() private readonly promptCache?: import("./prompt-cache.service").PromptCacheService,
  ) {
    this.prisma = prisma;
  }

  /**
   * Serialise the user-editable subset of an agent row into a
   * PlatosAgentVersion.snapshot JSON blob.
   *
   * `isActive`, scope fields, `name`, `slug`, and timestamps are intentionally
   * excluded — they describe identity/lifecycle, not behaviour. Rollback must
   * never rename an agent or move it between scopes.
   */
  private buildSnapshot(agent: any): AgentVersionSnapshot {
    return {
      model: agent.model,
      modelRoutes: (agent.modelRoutes as ModelRoute[] | null) ?? null,
      systemPrompt: agent.systemPrompt ?? null,
      promptBlocks: (agent.promptBlocks as PromptBlock[] | null) ?? null,
      dynamicBlocks: (agent.dynamicBlocks as DynamicBlockTemplate[] | null) ?? null,
      maxSteps: agent.maxSteps ?? 20,
      contextLimit: agent.contextLimit ?? 20,
      historyMode: agent.historyMode ?? "rolling",
      compactThreshold: agent.compactThreshold ?? 40,
      enableUserProfiling: !!agent.enableUserProfiling,
      toolMode: agent.toolMode ?? "direct",
      toolsBlockConfig: (agent.toolsBlockConfig as ToolsBlockConfig | null) ?? null,
      subAgentConfig: (agent.subAgentConfig as SubAgentConfig | null) ?? null,
      memoryConfig: (agent.memoryConfig as Record<string, unknown> | null) ?? null,
      metaTools: (agent.metaTools as Record<string, boolean> | null) ?? null,
      featureFlags: (agent.featureFlags as Record<string, boolean> | null) ?? null,
      // Theme F.5 — capture structured-output schema in the version snapshot.
      outputSchema: (agent.outputSchema as Record<string, unknown> | null) ?? null,
      // Theme O.2 — capture memory extraction policy so rollback restores it.
      extractionPolicy: (agent.extractionPolicy as Record<string, unknown> | null) ?? null,
      // PRA-TC — capture threading config so rollback restores the threading state.
      enableThreading: !!agent.enableThreading,
      threadingConfig: (agent.threadingConfig as Record<string, unknown> | null) ?? null,
    };
  }

  /**
   * Theme G — persist a new immutable snapshot row and bump `currentVersionId`.
   *
   * Version numbers are per-agent auto-increment (starting at 1). We fetch the
   * current max inside the same transaction so concurrent saves can't collide.
   */
  private async saveVersion(
    agentId: string,
    createdBy: string,
    snapshot: AgentVersionSnapshot,
    note?: string | null,
  ): Promise<any> {
    return this.prisma.$transaction(async (tx: any) => {
      const last = await tx.platosAgentVersion.findFirst({
        where: { agentId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });
      const next = (last?.versionNumber ?? 0) + 1;
      const version = await tx.platosAgentVersion.create({
        data: {
          agentId,
          versionNumber: next,
          createdBy,
          note: note ?? null,
          snapshot: snapshot as any,
        },
      });
      await tx.platosAgent.update({
        where: { id: agentId },
        data: { currentVersionId: version.id },
      });
      return version;
    });
  }

  async create(scope: RequestScope, dto: CreateAgentDto): Promise<AgentRecord> {
    const baseSlug = dto.slug || dto.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    // Slug uniqueness is (projectId, environmentId, slug).
    const existingSlug = await this.prisma.platosAgent.findUnique({
      where: {
        projectId_environmentId_slug: {
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          slug: baseSlug,
        },
      },
    });
    const slug = existingSlug ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug;
    // MCP `agents.create` callers often pass only `promptBlocks` (the
    // composable form) and leave `systemPrompt` empty. The turn-time
    // pipeline reads `systemPrompt` directly, so when it's NULL the
    // agent silently falls back to the generic default. Derive the
    // stored string from blocks whenever blocks are given and no
    // explicit systemPrompt was supplied. Fully back-compat: callers
    // that pass a systemPrompt + no blocks, or both, behave unchanged.
    const derivedSystemPrompt =
      !dto.systemPrompt &&
      Array.isArray(dto.promptBlocks) &&
      dto.promptBlocks.length > 0
        ? serializePromptBlocksToSystemPrompt(dto.promptBlocks)
        : null;
    const agent = await this.prisma.platosAgent.create({
      data: {
        name: dto.name,
        slug,
        model: dto.model,
        systemPrompt: dto.systemPrompt || derivedSystemPrompt || null,
        promptBlocks: (dto.promptBlocks as any) || null,
        dynamicBlocks: (dto.dynamicBlocks as any) || null,
        maxSteps: dto.maxSteps || 20,
        contextLimit: dto.contextLimit ?? 20,
        historyMode: dto.historyMode || "rolling",
        compactThreshold: dto.compactThreshold ?? 40,
        enableUserProfiling: dto.enableUserProfiling ?? false,
        toolMode: dto.toolMode || "direct",
        toolsBlockConfig: (dto.toolsBlockConfig as any) || null,
        subAgentConfig: (dto.subAgentConfig as any) || null,
        memoryConfig: dto.memoryConfig || null,
        metaTools: dto.metaTools || {
          find_tools: true,
          execute_tools: true,
          remember: true,
          recall: true,
          // Theme L — memory meta-tools (pgvector-backed). Scope-guarded,
          // enabled by default alongside `remember` / `recall`.
          forget: true,
          list_memories: true,
          relate: true,
          // Theme O — manual extraction trigger. Default off.
          memory_extract: false,
          // Theme F.6 — artifact meta-tools enabled by default on new agents.
          generate_artifact: true,
          revise_artifact: true,
          // Theme BGO — durable background-operation meta-tools. Dual-key
          // default (new name + deprecated alias) so freshly-created agent
          // rows work under both names during the one-release compat
          // window. See docs/BGO_RENAME.md.
          spawn_bgo: true,
          spawn_task: true,
          // W.1 — durable batch meta-tool. Spawns a trigger.dev loop that
          // runs one LLM turn (with a restricted tool subset) per item in
          // a list. Default-on alongside spawn_bgo; fallback to Redis stub
          // when trigger.dev isn't configured.
          agent_batch: true,
        },
        // Theme F.5 — agent-level default output schema.
        outputSchema: (dto.outputSchema as any) ?? null,
        // Theme O.2 — per-agent memory extraction policy.
        extractionPolicy: (dto.extractionPolicy as any) ?? null,
        // Per-request model routing table.
        modelRoutes: (dto.modelRoutes as any) ?? null,
        isActive: true,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      include: { _count: { select: { threads: true } } },
    });

    // Theme G — snapshot the initial config as version 1 so rollback history
    // starts on turn zero, not after the first edit.
    try {
      const snapshot = this.buildSnapshot(agent);
      await this.saveVersion(agent.id, scope.userId, snapshot, "Initial version");
    } catch (err: any) {
      console.warn(
        `[agent-crud] initial version snapshot failed for ${agent.id}: ${err?.message}`,
      );
    }

    // Invalidate config cache
    await this.redis.del(`agent:${agent.id}:config`);
    // Reload so the response carries `currentVersionId`.
    return this.findById(agent.id, scope) as Promise<AgentRecord>;
  }

  async findById(agentId: string, scope: RequestScope): Promise<AgentRecord | null> {
    return this.prisma.platosAgent.findFirst({
      where: {
        id: agentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      include: { _count: { select: { threads: true } } },
    });
  }

  async findBySlug(slug: string, scope: RequestScope): Promise<AgentRecord | null> {
    return this.prisma.platosAgent.findFirst({
      where: {
        slug,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      include: { _count: { select: { threads: true } } },
    });
  }

  async list(scope: RequestScope): Promise<AgentRecord[]> {
    return this.prisma.platosAgent.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      include: { _count: { select: { threads: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Update an agent's config.
   *
   * Theme G.2 — every save creates a new immutable `PlatosAgentVersion`
   * snapshot and advances `currentVersionId`, unless the payload is config-
   * irrelevant (only `name`/`isActive`/`featureFlags` changed).
   *
   * Version creation is decided by comparing the post-update snapshot against
   * the pre-update snapshot — a no-op update with the same JSON body does
   * NOT create a new version (keeps history readable).
   */
  async update(agentId: string, scope: RequestScope, dto: UpdateAgentDto): Promise<AgentRecord> {
    // Verify ownership
    const existing = await this.findById(agentId, scope);
    if (!existing) throw new Error("Agent not found");

    const beforeSnapshot = this.buildSnapshot(existing);

    // Mirror the create() guard: when callers PATCH `promptBlocks` only
    // and don't touch `systemPrompt`, re-serialize the blocks into the
    // systemPrompt column so the turn-time pipeline doesn't keep reading
    // the stale pre-patch string. An explicit `systemPrompt` in the same
    // PATCH still wins (caller's intent is "use my string as-is").
    const updateSystemPrompt =
      dto.systemPrompt !== undefined
        ? dto.systemPrompt
        : dto.promptBlocks !== undefined &&
            Array.isArray(dto.promptBlocks) &&
            dto.promptBlocks.length > 0
          ? serializePromptBlocksToSystemPrompt(dto.promptBlocks)
          : undefined;

    const agent = await this.prisma.platosAgent.update({
      where: { id: agentId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.model !== undefined && { model: dto.model }),
        ...(updateSystemPrompt !== undefined && { systemPrompt: updateSystemPrompt }),
        ...(dto.promptBlocks !== undefined && { promptBlocks: (dto.promptBlocks as any) }),
        ...(dto.dynamicBlocks !== undefined && { dynamicBlocks: (dto.dynamicBlocks as any) }),
        ...(dto.maxSteps !== undefined && { maxSteps: dto.maxSteps }),
        ...(dto.contextLimit !== undefined && { contextLimit: dto.contextLimit }),
        ...(dto.historyMode !== undefined && { historyMode: dto.historyMode }),
        ...(dto.compactThreshold !== undefined && { compactThreshold: dto.compactThreshold }),
        ...(dto.enableUserProfiling !== undefined && { enableUserProfiling: dto.enableUserProfiling }),
        ...(dto.enableThreading !== undefined && { enableThreading: dto.enableThreading }),
        ...(dto.threadingConfig !== undefined && { threadingConfig: dto.threadingConfig as any }),
        // PRA-AC: null explicitly clears cluster membership.
        ...(dto.clusteringId !== undefined && { clusteringId: dto.clusteringId ?? null }),
        ...(dto.toolMode !== undefined && { toolMode: dto.toolMode }),
        ...(dto.toolsBlockConfig !== undefined && { toolsBlockConfig: (dto.toolsBlockConfig as any) }),
        ...(dto.subAgentConfig !== undefined && { subAgentConfig: (dto.subAgentConfig as any) }),
        ...(dto.memoryConfig !== undefined && { memoryConfig: dto.memoryConfig }),
        ...(dto.metaTools !== undefined && { metaTools: dto.metaTools }),
        ...(dto.featureFlags !== undefined && { featureFlags: dto.featureFlags as any }),
        // Theme F.5 — explicit null allowed to clear the schema; undefined
        // leaves it untouched.
        ...(dto.outputSchema !== undefined && { outputSchema: dto.outputSchema as any }),
        // Theme O.2 — explicit null clears the stored policy (falls back to
        // defaults at runtime); undefined leaves it untouched.
        ...(dto.extractionPolicy !== undefined && {
          extractionPolicy: dto.extractionPolicy as any,
        }),
        // Theme CTX.6 — persist session-context mapping. Null clears; undefined
        // leaves untouched. The runtime resolver tolerates legacy shapes, so
        // UIs can ship incremental updates.
        ...(dto.contextMapping !== undefined && {
          contextMapping: dto.contextMapping as any,
        }),
        // PIFSP-14 — per-agent provider key pin. Null clears; undefined leaves.
        ...(dto.providerKeyId !== undefined && {
          providerKeyId: dto.providerKeyId,
        }),
        // Per-request model routing table. Null clears; undefined leaves.
        ...(dto.modelRoutes !== undefined && {
          modelRoutes: (dto.modelRoutes as any) ?? null,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      include: { _count: { select: { threads: true } } },
    });

    // Theme G.2 — snapshot the new config if anything visible to the runtime
    // actually changed. Comparing serialised JSON keeps this O(snapshot size)
    // and avoids spurious versions from no-op PATCH bodies.
    const afterSnapshot = this.buildSnapshot(agent);
    const changed = JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot);
    if (changed) {
      try {
        await this.saveVersion(agentId, scope.userId, afterSnapshot, dto.versionNote ?? null);
      } catch (err: any) {
        console.warn(
          `[agent-crud] save-as-version failed for ${agentId}: ${err?.message}`,
        );
      }
    }

    // Invalidate config cache + PIFSP-8 Layer-1 prompt cache
    await this.redis.del(`agent:${agentId}:config`);
    this.promptCache?.invalidate(agentId).catch(() => undefined);
    return this.findById(agentId, scope) as Promise<AgentRecord>;
  }

  // ═══════════════════════════════════════════════════════
  // Theme G — Version lifecycle
  // ═══════════════════════════════════════════════════════

  /**
   * List versions of an agent, most recent first.
   *
   * PPR-44 — paginated. Agents accrue a version per edit and previously this
   * endpoint loaded every row unbounded, which blows up the JSON payload and
   * the Postgres buffer cache for long-lived agents. Callers now page through
   * using `cursor` (the last version id they saw) + `take` (default 50, hard
   * cap 200). The response shape is a discriminated object rather than a raw
   * array — the controller flattens it for the HTTP response but keeps
   * `nextCursor` so the UI can request the next page.
   */
  async listVersions(
    agentId: string,
    scope: RequestScope,
    options: { cursor?: string | null; take?: number } = {},
  ): Promise<{ versions: AgentVersionRecord[]; nextCursor: string | null }> {
    const existing = await this.findById(agentId, scope);
    if (!existing) throw new Error("Agent not found");

    const requested = options.take ?? 50;
    const take = Math.max(1, Math.min(200, Math.floor(requested)));

    // Fetch one extra row so we can tell if there's another page without a
    // second count query. `cursor` addresses a row we've already seen, so we
    // `skip: 1` to land on the next one.
    const rows: any[] = await this.prisma.platosAgentVersion.findMany({
      where: { agentId },
      orderBy: { versionNumber: "desc" },
      take: take + 1,
      ...(options.cursor
        ? { cursor: { id: options.cursor }, skip: 1 }
        : {}),
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    const versions: AgentVersionRecord[] = page.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      versionNumber: r.versionNumber,
      createdBy: r.createdBy,
      note: r.note,
      snapshot: r.snapshot,
      createdAt: r.createdAt,
      isCurrent: existing.currentVersionId === r.id,
      isCanary: existing.canaryVersionId === r.id,
    }));

    return { versions, nextCursor };
  }

  /**
   * PPR-44 — retention helper for PlatosAgentVersion rows.
   *
   * Counts versions eligible for pruning under a `keep newest N OR newer
   * than keepDays` policy and logs the intent. Actual deletion is deferred
   * to a scheduled trigger.dev task (follow-up) — this helper is the
   * seam the task will call. Keeping it idempotent + read-only for now
   * means we can wire it into operational tooling without risk of
   * accidental history loss, and it makes the eventual DELETE a one-line
   * swap. Current (live) + canary versions are always preserved.
   */
  async pruneOldVersions(
    agentId: string,
    scope: RequestScope,
    options: { keepN?: number; keepDays?: number } = {},
  ): Promise<{ eligibleForPrune: number; kept: number; mode: "dry-run" }> {
    const existing = await this.findById(agentId, scope);
    if (!existing) throw new Error("Agent not found");

    const keepN = Math.max(1, Math.floor(options.keepN ?? 50));
    const keepDays = Math.max(1, Math.floor(options.keepDays ?? 90));
    const cutoff = new Date(Date.now() - keepDays * 86400_000);

    const all: any[] = await this.prisma.platosAgentVersion.findMany({
      where: { agentId },
      orderBy: { versionNumber: "desc" },
      select: { id: true, createdAt: true },
    });

    const protectedIds = new Set<string>();
    if (existing.currentVersionId) protectedIds.add(existing.currentVersionId);
    if (existing.canaryVersionId) protectedIds.add(existing.canaryVersionId);
    // Always keep the newest `keepN` rows regardless of age.
    for (const row of all.slice(0, keepN)) protectedIds.add(row.id);

    const eligible = all.filter(
      (r) => !protectedIds.has(r.id) && r.createdAt < cutoff,
    );

    // Dry-run: intent-log only. The follow-up task swaps this console.log for
    // a `deleteMany({ where: { id: { in: eligible.map(e => e.id) } } })`.
    console.log(
      `[agent-crud] pruneOldVersions(agent=${agentId}) keepN=${keepN} keepDays=${keepDays} total=${all.length} eligible=${eligible.length} kept=${all.length - eligible.length} [dry-run]`,
    );

    return {
      eligibleForPrune: eligible.length,
      kept: all.length - eligible.length,
      mode: "dry-run",
    };
  }

  /** Fetch a single version — used by diff view + rollback confirmation. */
  async getVersion(
    agentId: string,
    versionId: string,
    scope: RequestScope,
  ): Promise<AgentVersionRecord | null> {
    const existing = await this.findById(agentId, scope);
    if (!existing) return null;
    const row = await this.prisma.platosAgentVersion.findFirst({
      where: { id: versionId, agentId },
    });
    if (!row) return null;
    return {
      id: row.id,
      agentId: row.agentId,
      versionNumber: row.versionNumber,
      createdBy: row.createdBy,
      note: row.note,
      snapshot: row.snapshot as AgentVersionSnapshot,
      createdAt: row.createdAt,
      isCurrent: existing.currentVersionId === row.id,
      isCanary: existing.canaryVersionId === row.id,
    };
  }

  /**
   * Theme G.4 — roll back to an older version.
   *
   * Rather than mutate history (which would violate the "snapshot is
   * immutable" invariant from THEME_G §6), we copy the target snapshot's
   * fields onto the live `PlatosAgent` row and create a NEW version that
   * points at those same values — with `note` prefixed `Rollback to v<N>`.
   * Historical versions remain intact and queryable.
   *
   * The target snapshot's `model` is accepted verbatim — the UI is
   * responsible for warning on scope-filtered provider mismatches before
   * calling rollback. See THEME_G §1 + CLAUDE.md §8 "Model picker".
   */
  async rollbackToVersion(
    agentId: string,
    versionId: string,
    scope: RequestScope,
  ): Promise<AgentRecord> {
    const existing = await this.findById(agentId, scope);
    if (!existing) throw new Error("Agent not found");
    const target = await this.prisma.platosAgentVersion.findFirst({
      where: { id: versionId, agentId },
    });
    if (!target) throw new Error("Version not found");

    const snap = target.snapshot as AgentVersionSnapshot;

    await this.prisma.platosAgent.update({
      where: { id: agentId },
      data: {
        model: snap.model,
        systemPrompt: snap.systemPrompt,
        promptBlocks: (snap.promptBlocks as any) ?? null,
        dynamicBlocks: (snap.dynamicBlocks as any) ?? null,
        maxSteps: snap.maxSteps,
        contextLimit: snap.contextLimit,
        historyMode: snap.historyMode,
        compactThreshold: snap.compactThreshold,
        enableUserProfiling: snap.enableUserProfiling,
        toolMode: snap.toolMode,
        toolsBlockConfig: (snap.toolsBlockConfig as any) ?? null,
        subAgentConfig: (snap.subAgentConfig as any) ?? null,
        memoryConfig: (snap.memoryConfig as any) ?? null,
        metaTools: (snap.metaTools as any) ?? null,
        featureFlags: (snap.featureFlags as any) ?? null,
        // Theme F.5 — rollback also restores the output-schema hash.
        outputSchema: (snap.outputSchema as any) ?? null,
        // Theme O.2 — rollback restores the extraction policy too.
        extractionPolicy: (snap.extractionPolicy as any) ?? null,
        // Rollback restores the full model routes table.
        modelRoutes: (snap.modelRoutes as any) ?? null,
        // PRA-TC — rollback restores the threading state that was live at save time.
        enableThreading: snap.enableThreading ?? false,
        threadingConfig: (snap.threadingConfig as any) ?? null,
      },
    });

    await this.saveVersion(
      agentId,
      scope.userId,
      snap,
      `Rollback to v${target.versionNumber}`,
    );

    await this.redis.del(`agent:${agentId}:config`);
    return this.findById(agentId, scope) as Promise<AgentRecord>;
  }

  /**
   * Theme G.5 — configure canary routing for an agent.
   *
   * `canaryVersionId` must belong to this agent. `canaryPercent` is 0..100;
   * passing 0 disables canary routing by nulling the version pointer too,
   * so subsequent traffic falls back to the current version unambiguously.
   */
  async setCanary(
    agentId: string,
    scope: RequestScope,
    input: { canaryVersionId: string | null; canaryPercent: number },
  ): Promise<AgentRecord> {
    const existing = await this.findById(agentId, scope);
    if (!existing) throw new Error("Agent not found");

    const percent = Math.max(0, Math.min(100, Math.floor(input.canaryPercent || 0)));
    let versionId = input.canaryVersionId;
    if (percent === 0) {
      versionId = null;
    }
    if (versionId) {
      const exists = await this.prisma.platosAgentVersion.findFirst({
        where: { id: versionId, agentId },
        select: { id: true },
      });
      if (!exists) throw new Error("Canary version not found for this agent");
    }

    await this.prisma.platosAgent.update({
      where: { id: agentId },
      data: {
        canaryVersionId: versionId,
        canaryPercent: percent,
      },
    });

    // PPR-45 — every lifecycle change is a version. Previously `setCanary`
    // mutated the live row without recording a snapshot, so the audit trail
    // showed canary flips as phantom edits (no version row → no diff view).
    // Reload the row post-update so the snapshot reflects the new canary
    // fields, then save. Best-effort — never fail the update because of an
    // audit-trail hiccup (same contract as the `update()` path above).
    try {
      const reloaded = await this.prisma.platosAgent.findUnique({ where: { id: agentId } });
      if (reloaded) {
        const snap = this.buildSnapshot(reloaded);
        const note = versionId
          ? `Canary: ${percent}% → version ${versionId}`
          : "Canary: disabled";
        await this.saveVersion(agentId, scope.userId, snap, note);
      }
    } catch (err: any) {
      console.warn(
        `[agent-crud] save-as-version on setCanary failed for ${agentId}: ${err?.message}`,
      );
    }

    await this.redis.del(`agent:${agentId}:config`);
    // EOBD.44 — audit canary config changes.
    this.adminAudit?.record(scope, {
      action: "agent.canary.set",
      subjectType: "PlatosAgent",
      subjectId: agentId,
      beforeJson: {
        canaryVersionId: existing.canaryVersionId,
        canaryPercent: existing.canaryPercent,
      },
      afterJson: { canaryVersionId: versionId, canaryPercent: percent },
      source: "api",
    });
    return this.findById(agentId, scope) as Promise<AgentRecord>;
  }

  /**
   * EOBD.105 — one-click canary promotion.
   *
   * Atomically:
   *   1. Point `currentVersionId` at the canary version.
   *   2. Null `canaryVersionId` + set `canaryPercent = 0` so traffic
   *      fully drains to the promoted version.
   *   3. Save a version snapshot noting the promotion.
   *   4. Invalidate the config cache.
   *
   * Intended UI: single button on the canary-config page. Safer than
   * a two-step rollback-then-setCanary dance because it avoids a
   * window where the current version is the old one AND canary is
   * disabled simultaneously.
   */
  async promoteCanary(agentId: string, scope: RequestScope): Promise<AgentRecord> {
    const existing = await this.findById(agentId, scope);
    if (!existing) throw new Error("Agent not found");
    if (!existing.canaryVersionId) {
      throw new Error("No canary to promote — canaryVersionId is null");
    }
    const canaryId = existing.canaryVersionId;
    // Verify the canary version still belongs to this agent (defence
    // against a racing delete of the version row).
    const canaryRow = await this.prisma.platosAgentVersion.findFirst({
      where: { id: canaryId, agentId },
      select: { id: true, versionNumber: true },
    });
    if (!canaryRow) throw new Error("Canary version not found for this agent");

    await this.prisma.platosAgent.update({
      where: { id: agentId },
      data: {
        currentVersionId: canaryId,
        canaryVersionId: null,
        canaryPercent: 0,
      },
    });

    try {
      const reloaded = await this.prisma.platosAgent.findUnique({ where: { id: agentId } });
      if (reloaded) {
        const snap = this.buildSnapshot(reloaded);
        await this.saveVersion(
          agentId,
          scope.userId,
          snap,
          `Promote canary v${canaryRow.versionNumber ?? canaryId} → current`,
        );
      }
    } catch (err: any) {
      console.warn(
        `[agent-crud] save-as-version on promoteCanary failed for ${agentId}: ${err?.message}`,
      );
    }

    await this.redis.del(`agent:${agentId}:config`);
    // EOBD.44 — audit canary promotions separately from set-canary so
    // the timeline shows which version "won" an A/B.
    this.adminAudit?.record(scope, {
      action: "agent.canary.promote",
      subjectType: "PlatosAgent",
      subjectId: agentId,
      beforeJson: {
        previousCurrentVersionId: existing.currentVersionId,
        previousCanaryVersionId: existing.canaryVersionId,
        previousCanaryPercent: existing.canaryPercent,
      },
      afterJson: { currentVersionId: canaryId },
      source: "api",
    });
    return this.findById(agentId, scope) as Promise<AgentRecord>;
  }

  /**
   * Theme G.7 — update the per-agent feature flag map. Replaces the whole
   * object; callers should read-modify-write the prior flags if they want
   * partial updates.
   *
   * EOBD.104 — validates every key against `FEATURE_FLAG_REGISTRY`.
   * Unknown keys are rejected with a structured error so the webapp
   * editor can show the operator exactly what's wrong, rather than
   * silently persisting typos that the runtime never reads.
   */
  async setFeatureFlags(
    agentId: string,
    scope: RequestScope,
    flags: Record<string, boolean>,
  ): Promise<AgentRecord> {
    const existing = await this.findById(agentId, scope);
    if (!existing) throw new Error("Agent not found");

    // EOBD.104 — validate against the registry.
    const { validateFeatureFlags } = await import("../shared/feature-flag-registry");
    const result = validateFeatureFlags(flags);
    if (!result.ok) {
      const err: any = new Error(
        `Unknown feature flag key(s): ${result.unknownKeys.join(", ")}. See /api/v1/agent/feature-flags for the registry.`,
      );
      err.code = "unknown_feature_flag";
      err.unknownKeys = result.unknownKeys;
      throw err;
    }

    await this.prisma.platosAgent.update({
      where: { id: agentId },
      data: { featureFlags: result.flags as any },
    });

    // PPR-45 — same reasoning as `setCanary`: capture flag changes in
    // version history so the audit trail + diff view stay truthful. Flag
    // toggles are a common source of behavioural drift and hiding them
    // from the version timeline broke rollback-as-recovery.
    try {
      const reloaded = await this.prisma.platosAgent.findUnique({ where: { id: agentId } });
      if (reloaded) {
        const snap = this.buildSnapshot(reloaded);
        const keyCount = Object.keys(flags || {}).length;
        await this.saveVersion(
          agentId,
          scope.userId,
          snap,
          `Feature flags updated (${keyCount} key${keyCount === 1 ? "" : "s"})`,
        );
      }
    } catch (err: any) {
      console.warn(
        `[agent-crud] save-as-version on setFeatureFlags failed for ${agentId}: ${err?.message}`,
      );
    }

    await this.redis.del(`agent:${agentId}:config`);
    return this.findById(agentId, scope) as Promise<AgentRecord>;
  }

  async delete(agentId: string, scope: RequestScope): Promise<boolean> {
    const existing = await this.findById(agentId, scope);
    if (!existing) return false;
    await this.prisma.platosAgent.delete({ where: { id: agentId } });
    await this.redis.del(`agent:${agentId}:config`);
    // EOBD.44 — forensic trail for destructive admin ops.
    this.adminAudit?.record(scope, {
      action: "agent.delete",
      subjectType: "PlatosAgent",
      subjectId: agentId,
      beforeJson: { name: existing.name, slug: existing.slug, model: existing.model },
      source: "api",
    });
    return true;
  }

  /**
   * Theme G.6 — canary vs current metrics side-by-side.
   *
   * Pulls every assistant message in the last N hours for this agent and
   * groups by `responseJson.version_id`. Each group reports count, mean
   * latency (ms), total cost (cents), and error rate (messages with null
   * content after streaming — fast heuristic; the full E.2 error taxonomy
   * lands in Theme E's observability cleanup).
   *
   * Scope enforcement: we filter on `agent.organizationId / projectId /
   * environmentId` via the agent lookup (`findById`). The message query then
   * filters by `threadId ∈ agent.threads`, which inherits the scope.
   */
  async getCanaryMetrics(
    agentId: string,
    scope: RequestScope,
    options: { hours?: number } = {},
  ): Promise<{
    hours: number;
    currentVersionId: string | null;
    canaryVersionId: string | null;
    canaryPercent: number;
    perVersion: Array<{
      versionId: string | null;
      versionNumber: number | null;
      isCurrent: boolean;
      isCanary: boolean;
      messageCount: number;
      totalCostCents: number;
      avgLatencyMs: number | null;
      errorCount: number;
      errorRate: number;
    }>;
  }> {
    const existing = await this.findById(agentId, scope);
    if (!existing) throw new Error("Agent not found");

    const hours = Math.max(1, Math.min(720, Math.floor(options.hours ?? 24)));
    const since = new Date(Date.now() - hours * 3_600_000);

    // Pull raw assistant rows. We keep this small (select only responseJson +
    // createdAt + thread id) and bound by the time window.
    const rows: Array<{
      id: string;
      responseJson: any;
      createdAt: Date;
      content: string | null;
    }> = await this.prisma.platosAgentMessage.findMany({
      where: {
        role: "assistant",
        createdAt: { gte: since },
        thread: { agentId },
      },
      select: { id: true, responseJson: true, createdAt: true, content: true },
      orderBy: { createdAt: "asc" },
    });

    // Resolve version numbers up front so the UI can label v3 / v7 / etc.
    const versions: Array<{ id: string; versionNumber: number }> =
      await this.prisma.platosAgentVersion.findMany({
        where: { agentId },
        select: { id: true, versionNumber: true },
      });
    const versionNumberById = new Map(versions.map((v) => [v.id, v.versionNumber]));

    interface Bucket {
      messageCount: number;
      totalCostCents: number;
      latencySumMs: number;
      latencyCount: number;
      errorCount: number;
    }
    const byVersion = new Map<string | null, Bucket>();
    for (const r of rows) {
      const rj = (r.responseJson as {
        version_id?: string | null;
        cost_cents?: number;
        usage?: { inputTokens?: number; outputTokens?: number };
        latency_ms?: number;
      } | null) || null;
      const key: string | null = rj?.version_id ?? null;
      const b = byVersion.get(key) ?? {
        messageCount: 0,
        totalCostCents: 0,
        latencySumMs: 0,
        latencyCount: 0,
        errorCount: 0,
      };
      b.messageCount += 1;
      b.totalCostCents += Number(rj?.cost_cents ?? 0);
      if (typeof rj?.latency_ms === "number" && rj.latency_ms > 0) {
        b.latencySumMs += rj.latency_ms;
        b.latencyCount += 1;
      }
      // Error heuristic — an assistant message that finished with no text
      // usually means the stream errored out. The E.2 observability theme
      // will refine this with explicit error status.
      if (!r.content || r.content.length === 0) {
        b.errorCount += 1;
      }
      byVersion.set(key, b);
    }

    const perVersion = Array.from(byVersion.entries()).map(([versionId, b]) => ({
      versionId,
      versionNumber: versionId ? versionNumberById.get(versionId) ?? null : null,
      isCurrent: versionId !== null && versionId === existing.currentVersionId,
      isCanary: versionId !== null && versionId === existing.canaryVersionId,
      messageCount: b.messageCount,
      totalCostCents: Math.round(b.totalCostCents * 100) / 100,
      avgLatencyMs: b.latencyCount > 0 ? Math.round(b.latencySumMs / b.latencyCount) : null,
      errorCount: b.errorCount,
      errorRate: b.messageCount > 0 ? b.errorCount / b.messageCount : 0,
    }));

    // Stable ordering: current first, canary second, rest by message count.
    perVersion.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.isCanary !== b.isCanary) return a.isCanary ? -1 : 1;
      return b.messageCount - a.messageCount;
    });

    return {
      hours,
      currentVersionId: existing.currentVersionId ?? null,
      canaryVersionId: existing.canaryVersionId ?? null,
      canaryPercent: existing.canaryPercent ?? 0,
      perVersion,
    };
  }
}
