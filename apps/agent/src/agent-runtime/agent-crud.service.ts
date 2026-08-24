import { Injectable, Inject, Optional } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "../auth/scope.guard";
import { AdminAuditService } from "../monitoring/admin-audit.service";
import { addUsage, EMPTY_USAGE, roundCents, usageFromTurn } from "../monitoring/usage-ledger";
import { serializePromptBlocksToSystemPrompt } from "./prompt-builder.service";
import { isUuid } from "../shared/pagination";

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
 * PIFSP-19 — coerce a block-list field (`promptBlocks` / `dynamicBlocks`) to a
 * JSON array (or null) before it is persisted into a Prisma `Json?` column.
 *
 * The contract for these columns is "array of block objects". Postgres `jsonb`
 * also accepts a bare string scalar, so a client that double-encodes the field
 * — sends `JSON.stringify(blocks)` instead of `blocks` — lands a *string* in
 * the column and Prisma stores it verbatim. Every downstream reader assumes an
 * array:
 *   - the dashboard does `blocks.map(...)` → `"...".map is not a function`
 *     (minified: `z.map is not a function`), crashing the agent detail page;
 *   - the runtime guards with `Array.isArray(...)`, so a string silently drops
 *     every dynamic block and the agent answers ungrounded (no {{vars}}).
 *
 * One bad write therefore corrupts the row permanently. This normalizes at the
 * write boundary: parse-if-string, require-array, drop-to-null otherwise. It is
 * idempotent on already-correct arrays.
 */
function coerceBlockList(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return null;
  let v: unknown = value;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    try {
      v = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return Array.isArray(v) ? v : null;
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

/** The only valid tool-call methods. Anything else is coerced (see
 *  `normalizeToolsBlockConfig`). */
export const TOOL_CALL_MODES = ["direct", "sub-agent", "execute-tool"] as const;
export type ToolCallMode = (typeof TOOL_CALL_MODES)[number];

/**
 * CONSISTENCY (audit #1) — coerce `toolsBlockConfig.mode` to a valid value.
 *
 * The create wizard used to submit `"tool-wrapper"`, which is not in the enum:
 * nothing validated it, so it was stored raw, ignored at runtime (the only
 * runtime branch is `=== "sub-agent"`), and rendered BLANK in the edit
 * select — re-saving then skipped the field, making the bad value sticky.
 * That was the literal "I picked a tool mode and it wasn't respected".
 *
 * Applied on create AND update, so a legacy row self-heals on its next save
 * (no data migration required). `"tool-wrapper"` maps to its intended
 * semantics (`execute-tool`); any other unknown value falls back to `direct`.
 *
 * CRITICAL (Fable verify B1) — only touches a patch that ACTUALLY CARRIES a
 * `mode` key. A partial patch without one (e.g. the Tools tab sending just
 * `{displayMode}`) must pass through untouched: injecting a default `mode`
 * here would, after the shallow merge in `update()`, overwrite a stored
 * `sub-agent` with `direct` — silently resetting the tool-call method on
 * every partial API/MCP patch, i.e. the very bug this function exists to fix.
 */
export function normalizeToolsBlockConfig(cfg: unknown): unknown {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return cfg;
  const c = cfg as Record<string, unknown>;
  if (!("mode" in c)) return cfg;
  const mode = c.mode;
  if (typeof mode === "string" && (TOOL_CALL_MODES as readonly string[]).includes(mode)) {
    return cfg;
  }
  const coerced: ToolCallMode = mode === "tool-wrapper" ? "execute-tool" : "direct";
  return { ...c, mode: coerced };
}

/**
 * CONSISTENCY (audit #2) — shallow-merge a partial JSON config patch over the
 * stored object so a client that owns only some keys can't wipe the rest.
 * Explicit `null` clears the column; a non-object patch (or no prior value)
 * passes through unchanged.
 */
export function mergeJsonConfig(existing: unknown, patch: unknown): unknown {
  if (patch === null) return null;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return patch;
  return { ...(existing as Record<string, unknown>), ...(patch as Record<string, unknown>) };
}

export interface ToolsBlockConfig {
  /**
   * Execution mode — untouched by TL.2. Governs whether the parent LLM
   * calls tools directly, through a sub-agent, or via execute_tools only.
   */
  mode: ToolCallMode;
  enabledTools: string[];
  /**
   * TOOL EXPOSURE — what the model can actually CALL.
   *
   * "meta" (default): find_tools + execute_tools; entity tools sit behind them.
   * "direct": every scoped entity tool injected as a real schema, no meta-tools.
   *
   * Distinct from `mode` (who drives the calling) and `displayMode` (how much
   * is described in the prompt) -- neither of those ever governed callability.
   * Context tools (memory/profile/artifacts) are unaffected in both modes.
   */
  toolExposure?: "direct" | "meta";
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
  /** REFACTOR — direct (in-process, streamed) vs durable (runs as a Trigger.dev run). */
  executionMode?: "direct" | "durable";
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
  /** Anonymous embed access is opt-in and Environment deployment specific. */
  visibility?: "private" | "public-guest";
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
  executionMode?: "direct" | "durable";
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
  /** Anonymous embed access is opt-in and Environment deployment specific. */
  visibility?: "private" | "public-guest";
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
  /** CONSISTENCY (audit #8) — surfaced on the record so callers (e.g. clone)
   *  can carry it. The column always existed; only the type omitted it, which
   *  is exactly why agents_clone_from silently dropped durable mode. */
  executionMode?: string | null;
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
  /** Clean-tenancy compatibility fields stored inside AgentVersion.memoryConfig. */
  contextMapping?: Record<string, unknown> | null;
  providerKeyId?: string | null;
  visibility?: string | null;
  maxBgosPerTurn?: number | null;
  agentRetryConfig?: Record<string, unknown> | null;
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
  /** CONSISTENCY (audit #8) — surfaced on the record so callers (e.g. clone)
   *  can carry it. The column always existed; only the type omitted it, which
   *  is exactly why agents_clone_from silently dropped durable mode. */
  executionMode?: string | null;
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
  /** Environment-owned deployment state projected from AgentBinding. */
  clusteringId?: string | null;
  /** Compatibility settings carried inside the active AgentVersion. */
  visibility?: string | null;
  maxBgosPerTurn?: number | null;
  agentRetryConfig?: Record<string, unknown> | null;
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
    @Optional() private readonly promptCache?: import("./prompt-cache.service").PromptCacheService,
  ) {
    this.prisma = prisma;
  }

  private readonly defaultMetaTools: Record<string, boolean> = {
    find_tools: true,
    execute_tools: true,
    remember: true,
    recall: true,
    forget: true,
    list_memories: true,
    relate: true,
    memory_extract: false,
    spawn_bgo: true,
    spawn_task: true,
    agent_batch: true,
  };

  private scopeWhere(scope: RequestScope) {
    return {
      environmentId: scope.environmentId,
      environment: {
        project: {
          id: scope.projectId,
          organizationId: scope.organizationId,
        },
      },
      agent: { projectId: scope.projectId },
    };
  }

  private bindingInclude(scope: RequestScope) {
    return {
      environment: { include: { project: true } },
      agent: {
        include: {
          _count: {
            select: { threads: { where: { environmentId: scope.environmentId } } },
          },
        },
      },
      activeAgentVersion: true,
      canaryAgentVersion: true,
      cluster: true,
    };
  }

  private runtimeConfig(version: any): Record<string, any> {
    const memoryConfig = version?.memoryConfig;
    if (!memoryConfig || typeof memoryConfig !== "object" || Array.isArray(memoryConfig)) return {};
    const runtime = (memoryConfig as Record<string, unknown>).__runtime;
    return runtime && typeof runtime === "object" && !Array.isArray(runtime)
      ? runtime as Record<string, any>
      : {};
  }

  private publicMemoryConfig(version: any): Record<string, unknown> | null {
    const memoryConfig = version?.memoryConfig;
    if (!memoryConfig || typeof memoryConfig !== "object" || Array.isArray(memoryConfig)) return null;
    const { __runtime: _runtime, ...publicConfig } = memoryConfig as Record<string, unknown>;
    return Object.keys(publicConfig).length ? publicConfig : null;
  }

  private publicToolsConfig(version: any): ToolsBlockConfig | null {
    const value = version?.toolsBlockConfig;
    const config = value && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
    const enabledTools = this.runtimeConfig(version).enabledTools;
    if (Array.isArray(enabledTools)) config.enabledTools = enabledTools;
    return Object.keys(config).length ? config as unknown as ToolsBlockConfig : null;
  }

  private routesFromVersion(version: any): ModelRoute[] | null {
    const routes = coerceBlockList(version?.modelRoutes);
    if (!routes) return null;
    return routes.map((route: any) => ({
      ...route,
      providerKeyId: route.providerKeyId ?? route.providerCredentialId ?? null,
    })) as ModelRoute[];
  }

  private buildSnapshot(source: any): AgentVersionSnapshot {
    return {
      model: source.model,
      modelRoutes: coerceBlockList(source.modelRoutes) as ModelRoute[] | null,
      systemPrompt: source.systemPrompt ?? null,
      promptBlocks: coerceBlockList(source.promptBlocks) as PromptBlock[] | null,
      dynamicBlocks: coerceBlockList(source.dynamicBlocks) as DynamicBlockTemplate[] | null,
      maxSteps: source.maxSteps ?? 20,
      contextLimit: source.contextLimit ?? 20,
      historyMode: source.historyMode ?? "rolling",
      compactThreshold: source.compactThreshold ?? 40,
      enableUserProfiling: !!source.enableUserProfiling,
      toolMode: source.toolMode ?? source.toolsBlockConfig?.mode ?? "direct",
      executionMode: source.executionMode ?? "direct",
      toolsBlockConfig: (source.toolsBlockConfig as ToolsBlockConfig | null) ?? null,
      subAgentConfig: (source.subAgentConfig as SubAgentConfig | null) ?? null,
      memoryConfig: (source.memoryConfig as Record<string, unknown> | null) ?? null,
      metaTools: (source.metaTools as Record<string, boolean> | null) ?? null,
      featureFlags: (source.featureFlags as Record<string, boolean> | null) ?? null,
      outputSchema: (source.outputSchema as Record<string, unknown> | null) ?? null,
      extractionPolicy: (source.extractionPolicy as Record<string, unknown> | null) ?? null,
      enableThreading: !!source.enableThreading,
      threadingConfig: (source.threadingConfig as Record<string, unknown> | null) ?? null,
      contextMapping: (source.contextMapping as Record<string, unknown> | null) ?? null,
      providerKeyId: source.providerKeyId ?? null,
      visibility: source.visibility ?? null,
      maxBgosPerTurn: source.maxBgosPerTurn ?? null,
      agentRetryConfig: (source.agentRetryConfig as Record<string, unknown> | null) ?? null,
    };
  }

  private snapshotFromVersion(version: any): AgentVersionSnapshot {
    const runtime = this.runtimeConfig(version);
    return this.buildSnapshot({
      model: version.model,
      modelRoutes: this.routesFromVersion(version),
      systemPrompt: version.systemPrompt,
      promptBlocks: version.promptBlocks,
      dynamicBlocks: version.dynamicBlocks,
      maxSteps: version.maxSteps,
      contextLimit: version.contextLimit,
      historyMode: runtime.historyMode,
      compactThreshold: runtime.compactThreshold,
      enableUserProfiling: runtime.enableUserProfiling,
      toolMode: runtime.toolMode,
      executionMode: runtime.executionMode,
      toolsBlockConfig: this.publicToolsConfig(version),
      subAgentConfig: runtime.subAgentConfig,
      memoryConfig: this.publicMemoryConfig(version),
      metaTools: runtime.metaTools,
      featureFlags: runtime.featureFlags,
      outputSchema: version.outputSchema,
      extractionPolicy: runtime.extractionPolicy,
      enableThreading: runtime.enableThreading,
      threadingConfig: runtime.threadingConfig,
      contextMapping: runtime.contextMapping,
      providerKeyId: runtime.providerKeyId,
      visibility: runtime.visibility,
      maxBgosPerTurn: runtime.maxBgosPerTurn,
      agentRetryConfig: runtime.agentRetryConfig,
    });
  }

  private versionData(
    snapshot: AgentVersionSnapshot,
    createdBy: string,
    versionNumber: number,
    note?: string | null,
    toolDefaultPolicy: "NONE" | "ALL" = "ALL",
  ) {
    const tools = snapshot.toolsBlockConfig && typeof snapshot.toolsBlockConfig === "object"
      ? { ...(snapshot.toolsBlockConfig as unknown as Record<string, unknown>) }
      : {};
    const enabledTools = Array.isArray(tools.enabledTools) ? tools.enabledTools : undefined;
    delete tools.enabledTools;
    if (snapshot.toolMode && tools.mode === undefined) tools.mode = snapshot.toolMode;

    const publicMemory = snapshot.memoryConfig && typeof snapshot.memoryConfig === "object"
      ? { ...snapshot.memoryConfig }
      : {};
    delete (publicMemory as Record<string, unknown>).__runtime;
    const runtime = {
      historyMode: snapshot.historyMode,
      compactThreshold: snapshot.compactThreshold,
      enableUserProfiling: snapshot.enableUserProfiling,
      toolMode: snapshot.toolMode,
      executionMode: snapshot.executionMode ?? "direct",
      subAgentConfig: snapshot.subAgentConfig,
      metaTools: snapshot.metaTools,
      featureFlags: snapshot.featureFlags,
      extractionPolicy: snapshot.extractionPolicy,
      enableThreading: snapshot.enableThreading,
      threadingConfig: snapshot.threadingConfig,
      contextMapping: snapshot.contextMapping ?? null,
      providerKeyId: snapshot.providerKeyId ?? null,
      visibility: snapshot.visibility ?? null,
      maxBgosPerTurn: snapshot.maxBgosPerTurn ?? null,
      agentRetryConfig: snapshot.agentRetryConfig ?? null,
      ...(enabledTools ? { enabledTools } : {}),
    };
    const modelRoutes = (coerceBlockList(snapshot.modelRoutes) ?? []).map((route: any) => {
      const { providerKeyId, ...rest } = route;
      return {
        ...rest,
        ...(providerKeyId ? { providerCredentialId: providerKeyId } : {}),
      };
    });

    return {
      versionNumber,
      model: snapshot.model || "anthropic:claude-sonnet-4-6",
      systemPrompt: snapshot.systemPrompt ?? null,
      maxSteps: snapshot.maxSteps ?? 20,
      contextLimit: snapshot.contextLimit ?? 20,
      toolDefaultPolicy,
      promptBlocks: coerceBlockList(snapshot.promptBlocks) ?? [],
      dynamicBlocks: coerceBlockList(snapshot.dynamicBlocks) ?? [],
      toolsBlockConfig: tools,
      modelRoutes,
      memoryConfig: { ...publicMemory, __runtime: runtime },
      ...(snapshot.outputSchema == null ? {} : { outputSchema: snapshot.outputSchema }),
      note: note ?? null,
      createdBy,
    };
  }

  private async createVersion(
    tx: any,
    agentId: string,
    createdBy: string,
    snapshot: AgentVersionSnapshot,
    note?: string | null,
    toolDefaultPolicy: "NONE" | "ALL" = "ALL",
  ): Promise<any> {
    const last = await tx.agentVersion.findFirst({
      where: { agentId },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    return tx.agentVersion.create({
      data: {
        agentId,
        ...this.versionData(
          snapshot,
          createdBy,
          (last?.versionNumber ?? 0) + 1,
          note,
          toolDefaultPolicy,
        ),
      },
    });
  }

  /**
   * AgentSkill is owned by an immutable AgentVersion. Every replacement
   * version therefore needs its own rows before an AgentBinding can point at
   * it. `environmentSkillId` is the canonical skill identity; enabled/config
   * are the version-specific assignment state copied verbatim.
   */
  private async cloneVersionSkills(
    tx: any,
    sourceAgentVersionId: string,
    destinationAgentVersionId: string,
  ): Promise<void> {
    const skills = await tx.agentSkill.findMany({
      where: { agentVersionId: sourceAgentVersionId },
      select: {
        environmentSkillId: true,
        enabled: true,
        config: true,
      },
    });
    if (skills.length === 0) return;
    await tx.agentSkill.createMany({
      data: skills.map((skill: any) => ({
        agentVersionId: destinationAgentVersionId,
        environmentSkillId: skill.environmentSkillId,
        enabled: skill.enabled,
        config: skill.config,
      })),
    });
  }

  /** Copy immutable-version Tool policy state, optionally replacing one Tool. */
  private async cloneVersionToolPolicies(
    tx: any,
    sourceAgentVersionId: string,
    destinationAgentVersionId: string,
    replacement?: { toolId: string; effect: "ALLOW" | "DENY" },
  ): Promise<void> {
    const policies = await tx.agentToolPolicy.findMany({
      where: { agentVersionId: sourceAgentVersionId },
      select: { toolId: true, effect: true, priority: true },
    });
    const byToolId = new Map<string, { toolId: string; effect: "ALLOW" | "DENY"; priority: number }>(
      policies.map((policy: any) => [policy.toolId, policy]),
    );
    if (replacement) {
      byToolId.set(replacement.toolId, { ...replacement, priority: 0 });
    }
    if (byToolId.size === 0) return;
    await tx.agentToolPolicy.createMany({
      data: [...byToolId.values()].map((policy) => ({
        agentVersionId: destinationAgentVersionId,
        ...policy,
      })),
    });
  }

  private projectBinding(binding: any): AgentRecord {
    const snapshot = this.snapshotFromVersion(binding.activeAgentVersion);
    return {
      id: binding.agent.id,
      name: binding.agent.name,
      slug: binding.agent.slug,
      ...snapshot,
      isActive: binding.agent.isActive,
      organizationId: binding.environment.project.organizationId,
      projectId: binding.environment.projectId,
      environmentId: binding.environmentId,
      currentVersionId: binding.activeAgentVersionId,
      canaryVersionId: binding.canaryAgentVersionId ?? null,
      canaryPercent: binding.canaryPercent ?? 0,
      clusteringId: binding.clusterId ?? null,
      createdAt: binding.agent.createdAt,
      updatedAt: binding.updatedAt,
      _count: binding.agent._count,
    } as AgentRecord;
  }

  private async findBinding(agentId: string, scope: RequestScope): Promise<any | null> {
    return this.prisma.agentBinding.findFirst({
      where: { agentId, ...this.scopeWhere(scope) },
      include: this.bindingInclude(scope),
    });
  }

  async create(scope: RequestScope, dto: CreateAgentDto): Promise<AgentRecord> {
    const baseSlug = dto.slug || dto.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    let createModel: string | undefined = dto.model;
    if (!createModel && Array.isArray(dto.modelRoutes)) {
      const def = dto.modelRoutes.find((route) => route.isDefault) ?? dto.modelRoutes[0];
      if (def?.model) createModel = def.model;
    }
    const derivedSystemPrompt = !dto.systemPrompt && dto.promptBlocks?.length
      ? serializePromptBlocksToSystemPrompt(dto.promptBlocks)
      : null;
    const initial = this.buildSnapshot({
      ...dto,
      model: createModel || "anthropic:claude-sonnet-4-6",
      systemPrompt: dto.systemPrompt || derivedSystemPrompt || null,
      promptBlocks: dto.promptBlocks ?? [],
      dynamicBlocks: dto.dynamicBlocks ?? [],
      maxSteps: dto.maxSteps || 20,
      contextLimit: dto.contextLimit ?? 20,
      historyMode: dto.historyMode || "rolling",
      compactThreshold: dto.compactThreshold ?? 40,
      enableUserProfiling: dto.enableUserProfiling ?? false,
      toolMode: dto.toolMode || "direct",
      executionMode: dto.executionMode || "direct",
      toolsBlockConfig: normalizeToolsBlockConfig(dto.toolsBlockConfig) || null,
      metaTools: dto.metaTools || this.defaultMetaTools,
      visibility: (dto as any).visibility ?? null,
    });

    const agentId = await this.prisma.$transaction(async (tx: any) => {
      const environment = await tx.environment.findFirst({
        where: {
          id: scope.environmentId,
          project: { id: scope.projectId, organizationId: scope.organizationId },
        },
        select: { id: true, projectId: true },
      });
      if (!environment) throw new Error("Environment not found or access denied");

      const existingSlug = await tx.agent.findUnique({
        where: { projectId_slug: { projectId: environment.projectId, slug: baseSlug } },
        select: { id: true },
      });
      const slug = existingSlug ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug;
      const agent = await tx.agent.create({
        data: {
          projectId: environment.projectId,
          name: dto.name,
          slug,
          isActive: true,
        },
      });
      const version = await this.createVersion(tx, agent.id, scope.userId, initial, "Initial version");
      await tx.agentBinding.create({
        data: {
          environmentId: environment.id,
          agentId: agent.id,
          activeAgentVersionId: version.id,
        },
      });
      return agent.id;
    });

    await this.invalidate(agentId, scope);
    return (await this.findById(agentId, scope))!;
  }

  async findById(agentId: string, scope: RequestScope): Promise<AgentRecord | null> {
    const binding = await this.findBinding(agentId, scope);
    return binding ? this.projectBinding(binding) : null;
  }

  async findBySlug(slug: string, scope: RequestScope): Promise<AgentRecord | null> {
    const binding = await this.prisma.agentBinding.findFirst({
      where: { ...this.scopeWhere(scope), agent: { projectId: scope.projectId, slug } },
      include: this.bindingInclude(scope),
    });
    return binding ? this.projectBinding(binding) : null;
  }

  async list(scope: RequestScope): Promise<AgentRecord[]> {
    const bindings = await this.prisma.agentBinding.findMany({
      where: this.scopeWhere(scope),
      include: this.bindingInclude(scope),
      orderBy: { createdAt: "desc" },
    });
    return bindings.map((binding: any) => this.projectBinding(binding));
  }

  async listPage(
    scope: RequestScope,
    options: { limit: number; offset: number; search?: string | null; status?: "active" | "paused" | null },
  ): Promise<{ agents: AgentRecord[]; total: number }> {
    const where = {
      ...this.scopeWhere(scope),
      agent: {
        projectId: scope.projectId,
        ...(options.status ? { isActive: options.status === "active" } : {}),
        ...(options.search
          ? {
              OR: [
                { name: { contains: options.search, mode: "insensitive" as const } },
                { slug: { contains: options.search, mode: "insensitive" as const } },
                ...(isUuid(options.search) ? [{ id: { equals: options.search } }] : []),
              ],
            }
          : {}),
      },
    };
    const [bindings, total] = await Promise.all([
      this.prisma.agentBinding.findMany({
        where,
        include: this.bindingInclude(scope),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: options.limit,
        skip: options.offset,
      }),
      this.prisma.agentBinding.count({ where }),
    ]);
    return {
      agents: bindings.map((binding: any) => this.projectBinding(binding)),
      total,
    };
  }

  async update(agentId: string, scope: RequestScope, dto: UpdateAgentDto): Promise<AgentRecord> {
    const existingBinding = await this.findBinding(agentId, scope);
    if (!existingBinding) throw new Error("Agent not found");
    const existing = this.projectBinding(existingBinding);
    const updateSystemPrompt = dto.systemPrompt !== undefined
      ? dto.systemPrompt
      : dto.promptBlocks?.length
        ? serializePromptBlocksToSystemPrompt(dto.promptBlocks)
        : existing.systemPrompt;
    let syncedModel = dto.model ?? existing.model;
    if (dto.model === undefined && Array.isArray(dto.modelRoutes)) {
      const def = dto.modelRoutes.find((route) => route.isDefault) ?? dto.modelRoutes[0];
      if (def?.model) syncedModel = def.model;
    }
    let toolsBlockConfig = dto.toolsBlockConfig !== undefined
      ? mergeJsonConfig(existing.toolsBlockConfig, normalizeToolsBlockConfig(dto.toolsBlockConfig))
      : existing.toolsBlockConfig;
    if (dto.toolMode !== undefined) {
      toolsBlockConfig = mergeJsonConfig(toolsBlockConfig, { mode: dto.toolMode });
    }
    const next = this.buildSnapshot({
      ...existing,
      ...dto,
      model: syncedModel,
      systemPrompt: updateSystemPrompt,
      promptBlocks: dto.promptBlocks !== undefined ? coerceBlockList(dto.promptBlocks) : existing.promptBlocks,
      dynamicBlocks: dto.dynamicBlocks !== undefined ? coerceBlockList(dto.dynamicBlocks) : existing.dynamicBlocks,
      toolsBlockConfig,
      subAgentConfig: dto.subAgentConfig !== undefined
        ? mergeJsonConfig(existing.subAgentConfig, dto.subAgentConfig)
        : existing.subAgentConfig,
      memoryConfig: dto.memoryConfig !== undefined ? dto.memoryConfig : existing.memoryConfig,
      visibility: (dto as any).visibility !== undefined ? (dto as any).visibility : (existing as any).visibility,
    });
    const changed = JSON.stringify(this.buildSnapshot(existing)) !== JSON.stringify(next);

    await this.prisma.$transaction(async (tx: any) => {
      if (dto.name !== undefined || dto.isActive !== undefined) {
        await tx.agent.update({
          where: { id: agentId },
          data: {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          },
        });
      }
      if (dto.clusteringId !== undefined) {
        if (dto.clusteringId) {
          const cluster = await tx.agentCluster.findFirst({
            where: {
              id: dto.clusteringId,
              environmentId: scope.environmentId,
              environment: {
                project: { id: scope.projectId, organizationId: scope.organizationId },
              },
            },
            select: { id: true },
          });
          if (!cluster) throw new Error("Cluster not found or access denied");
        }
        await tx.agentBinding.update({
          where: { id: existingBinding.id },
          data: { clusterId: dto.clusteringId ?? null },
        });
      }
      if (changed) {
        const version = await this.createVersion(
          tx,
          agentId,
          scope.userId,
          next,
          dto.versionNote ?? null,
          existingBinding.activeAgentVersion.toolDefaultPolicy,
        );
        await this.cloneVersionSkills(
          tx,
          existingBinding.activeAgentVersionId,
          version.id,
        );
        await this.cloneVersionToolPolicies(
          tx,
          existingBinding.activeAgentVersionId,
          version.id,
        );
        await tx.agentBinding.update({
          where: { id: existingBinding.id },
          data: { activeAgentVersionId: version.id },
        });
      }
    });

    await this.invalidate(agentId, scope);
    return (await this.findById(agentId, scope))!;
  }

  async listVersions(
    agentId: string,
    scope: RequestScope,
    options: { cursor?: string | null; take?: number; offset?: number } = {},
  ): Promise<{ versions: AgentVersionRecord[]; nextCursor: string | null; total: number; offset: number; limit: number }> {
    const binding = await this.findBinding(agentId, scope);
    if (!binding) throw new Error("Agent not found");
    const take = Math.max(1, Math.min(200, Math.floor(options.take ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const [rows, total] = await Promise.all([
      this.prisma.agentVersion.findMany({
        where: { agentId },
        orderBy: [{ versionNumber: "desc" }, { id: "desc" }],
        take: take + 1,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : { skip: offset }),
      }),
      this.prisma.agentVersion.count({ where: { agentId } }),
    ]);
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      versions: page.map((row: any) => this.projectVersion(row, binding)),
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
      total,
      offset: options.cursor ? 0 : offset,
      limit: take,
    };
  }

  async pruneOldVersions(
    agentId: string,
    scope: RequestScope,
    options: { keepN?: number; keepDays?: number } = {},
  ): Promise<{ eligibleForPrune: number; kept: number; mode: "dry-run" }> {
    const binding = await this.findBinding(agentId, scope);
    if (!binding) throw new Error("Agent not found");
    const keepN = Math.max(1, Math.floor(options.keepN ?? 50));
    const keepDays = Math.max(1, Math.floor(options.keepDays ?? 90));
    const cutoff = new Date(Date.now() - keepDays * 86400_000);
    const all = await this.prisma.agentVersion.findMany({
      where: { agentId },
      orderBy: { versionNumber: "desc" },
      select: { id: true, createdAt: true },
    });
    const protectedIds = new Set<string>([
      binding.activeAgentVersionId,
      ...(binding.canaryAgentVersionId ? [binding.canaryAgentVersionId] : []),
      ...all.slice(0, keepN).map((row: any) => row.id),
    ]);
    const eligible = all.filter((row: any) => !protectedIds.has(row.id) && row.createdAt < cutoff);
    console.log(
      `[agent-crud] pruneOldVersions(agent=${agentId}) keepN=${keepN} keepDays=${keepDays} total=${all.length} eligible=${eligible.length} kept=${all.length - eligible.length} [dry-run]`,
    );
    return { eligibleForPrune: eligible.length, kept: all.length - eligible.length, mode: "dry-run" };
  }

  private projectVersion(row: any, binding: any): AgentVersionRecord {
    return {
      id: row.id,
      agentId: row.agentId,
      versionNumber: row.versionNumber,
      createdBy: row.createdBy,
      note: row.note,
      snapshot: this.snapshotFromVersion(row),
      createdAt: row.createdAt,
      isCurrent: binding.activeAgentVersionId === row.id,
      isCanary: binding.canaryAgentVersionId === row.id,
    };
  }

  async getVersion(agentId: string, versionId: string, scope: RequestScope): Promise<AgentVersionRecord | null> {
    const binding = await this.findBinding(agentId, scope);
    if (!binding) return null;
    const row = await this.prisma.agentVersion.findFirst({ where: { id: versionId, agentId } });
    return row ? this.projectVersion(row, binding) : null;
  }

  async rollbackToVersion(agentId: string, versionId: string, scope: RequestScope): Promise<AgentRecord> {
    const binding = await this.findBinding(agentId, scope);
    if (!binding) throw new Error("Agent not found");
    const target = await this.prisma.agentVersion.findFirst({ where: { id: versionId, agentId } });
    if (!target) throw new Error("Version not found");
    await this.prisma.$transaction(async (tx: any) => {
      const version = await this.createVersion(
        tx,
        agentId,
        scope.userId,
        this.snapshotFromVersion(target),
        `Rollback to v${target.versionNumber}`,
        target.toolDefaultPolicy,
      );
      await this.cloneVersionSkills(tx, target.id, version.id);
      await this.cloneVersionToolPolicies(tx, target.id, version.id);
      await tx.agentBinding.update({
        where: { id: binding.id },
        data: { activeAgentVersionId: version.id },
      });
    });
    await this.invalidate(agentId, scope);
    return (await this.findById(agentId, scope))!;
  }

  /**
   * Replace one Tool policy on the active AgentVersion for this Environment.
   * A new immutable version is created and only the scoped AgentBinding moves,
   * so another Agent or another Environment binding cannot be changed by this
   * dashboard mutation.
   */
  async setToolEnabled(
    agentId: string,
    toolId: string,
    scope: RequestScope,
    enabled: boolean,
  ): Promise<{
    agentId: string;
    agentVersionId: string;
    previousAgentVersionId: string;
    toolId: string;
    enabled: boolean;
  } | null> {
    const result = await this.prisma.$transaction(async (tx: any) => {
      // Serialize version replacement for this scoped binding. The subsequent
      // Prisma read derives all ancestry from canonical relations rather than
      // trusting request-supplied organization/project ownership.
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "AgentBinding" WHERE "environmentId" = $1::uuid AND "agentId" = $2::uuid FOR UPDATE',
        scope.environmentId,
        agentId,
      );
      const binding = await tx.agentBinding.findFirst({
        where: { agentId, ...this.scopeWhere(scope) },
        include: this.bindingInclude(scope),
      });
      if (!binding || binding.activeAgentVersion.agentId !== agentId) return null;

      const mapping = await tx.environmentEntityTool.findFirst({
        where: {
          environmentId: scope.environmentId,
          toolId,
          environment: {
            project: { id: scope.projectId, organizationId: scope.organizationId },
          },
          entity: {
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
          },
        },
        select: { toolId: true },
      });
      if (!mapping) return null;

      const previousAgentVersionId = binding.activeAgentVersionId;
      const version = await this.createVersion(
        tx,
        agentId,
        scope.userId,
        this.snapshotFromVersion(binding.activeAgentVersion),
        `${enabled ? "Enable" : "Disable"} Agent Tool ${toolId}`,
        binding.activeAgentVersion.toolDefaultPolicy,
      );
      await this.cloneVersionSkills(tx, previousAgentVersionId, version.id);
      await this.cloneVersionToolPolicies(tx, previousAgentVersionId, version.id, {
        toolId,
        effect: enabled ? "ALLOW" : "DENY",
      });
      await tx.agentBinding.update({
        where: { id: binding.id },
        data: { activeAgentVersionId: version.id },
      });
      return {
        agentId,
        agentVersionId: version.id,
        previousAgentVersionId,
        toolId,
        enabled,
      };
    });
    if (result) await this.invalidate(agentId, scope);
    return result;
  }

  async setCanary(
    agentId: string,
    scope: RequestScope,
    input: { canaryVersionId: string | null; canaryPercent: number },
  ): Promise<AgentRecord> {
    const binding = await this.findBinding(agentId, scope);
    if (!binding) throw new Error("Agent not found");
    const percent = Math.max(0, Math.min(100, Math.floor(input.canaryPercent || 0)));
    const versionId = percent === 0 ? null : input.canaryVersionId;
    if (versionId) {
      const version = await this.prisma.agentVersion.findFirst({
        where: { id: versionId, agentId },
        select: { id: true },
      });
      if (!version) throw new Error("Canary version not found for this agent");
    }
    await this.prisma.agentBinding.update({
      where: { id: binding.id },
      data: { canaryAgentVersionId: versionId, canaryPercent: percent },
    });
    await this.invalidate(agentId, scope);
    this.adminAudit?.record(scope, {
      action: "agent.canary.set",
      subjectType: "Agent",
      subjectId: agentId,
      beforeJson: {
        canaryVersionId: binding.canaryAgentVersionId,
        canaryPercent: binding.canaryPercent,
      },
      afterJson: { canaryVersionId: versionId, canaryPercent: percent },
      source: "api",
    });
    return (await this.findById(agentId, scope))!;
  }

  async promoteCanary(agentId: string, scope: RequestScope): Promise<AgentRecord> {
    const binding = await this.findBinding(agentId, scope);
    if (!binding) throw new Error("Agent not found");
    if (!binding.canaryAgentVersionId) throw new Error("No canary to promote — canaryVersionId is null");
    const canaryId = binding.canaryAgentVersionId;
    await this.prisma.$transaction(async (tx: any) => {
      await tx.agentBinding.update({
        where: { id: binding.id },
        data: {
          activeAgentVersionId: canaryId,
          canaryAgentVersionId: null,
          canaryPercent: 0,
        },
      });
      await tx.adminAudit.create({
        data: {
          environmentId: scope.environmentId,
          actorUserId: scope.userId ?? null,
          action: "agent.canary.promote",
          subjectType: "Agent",
          subjectId: agentId,
          before: {
            previousCurrentVersionId: binding.activeAgentVersionId,
            previousCanaryVersionId: canaryId,
            previousCanaryPercent: binding.canaryPercent,
          },
          after: { currentVersionId: canaryId },
          source: "api",
        },
      });
    });
    await this.invalidate(agentId, scope);
    return (await this.findById(agentId, scope))!;
  }

  async setFeatureFlags(agentId: string, scope: RequestScope, flags: Record<string, boolean>): Promise<AgentRecord> {
    const existing = await this.findById(agentId, scope);
    if (!existing) throw new Error("Agent not found");
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
    return this.update(agentId, scope, {
      featureFlags: result.flags,
      versionNote: `Feature flags updated (${Object.keys(flags).length} key${Object.keys(flags).length === 1 ? "" : "s"})`,
    });
  }

  async delete(agentId: string, scope: RequestScope): Promise<boolean> {
    const binding = await this.findBinding(agentId, scope);
    if (!binding) return false;
    await this.prisma.$transaction(async (tx: any) => {
      await tx.agentBinding.delete({ where: { id: binding.id } });
      const remaining = await tx.agentBinding.count({ where: { agentId } });
      if (remaining === 0) {
        await tx.agent.update({ where: { id: agentId }, data: { isActive: false } });
      }
    });
    await this.invalidate(agentId, scope);
    this.adminAudit?.record(scope, {
      action: "agent.delete",
      subjectType: "AgentBinding",
      subjectId: binding.id,
      beforeJson: { agentId, name: binding.agent.name, slug: binding.agent.slug },
      source: "api",
    });
    return true;
  }

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
      turnCount: number;
      tasks: number;
      totalCostCents: number;
      inputTokens: number;
      outputTokens: number;
      avgLatencyMs: number | null;
      errorCount: number;
      errorRate: number;
    }>;
  }> {
    const binding = await this.findBinding(agentId, scope);
    if (!binding) throw new Error("Agent not found");
    const hours = Math.max(1, Math.min(720, Math.floor(options.hours ?? 24)));
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await this.prisma.turn.findMany({
      where: {
        createdAt: { gte: since },
        thread: {
          agentId,
          environmentId: scope.environmentId,
          environment: { project: { id: scope.projectId, organizationId: scope.organizationId } },
        },
      },
      // WIN-134 — this read `version_id` and `cost_cents` off the `output` JSON
      // column. Nothing has ever written either key there (the only writers put
      // `structuredOutput` or `error` in it), so the canary comparison reported
      // every turn under version `null` at a cost of exactly 0 — a panel whose
      // job is to decide whether to promote a version, answering 0 to both
      // questions it asks. Both facts are real columns.
      select: {
        agentVersionId: true,
        costCents: true,
        status: true,
        outputText: true,
        startedAt: true,
        completedAt: true,
        steps: {
          select: {
            inputTokens: true,
            outputTokens: true,
            cacheReadInputTokens: true,
            cacheCreationInputTokens: true,
            reasoningTokens: true,
            costCents: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const versions = await this.prisma.agentVersion.findMany({
      where: { agentId },
      select: { id: true, versionNumber: true },
    });
    const versionNumberById = new Map<string, number>(
      versions.map((version: any) => [version.id, Number(version.versionNumber)]),
    );
    const byVersion = new Map<string | null, any>();
    for (const row of rows) {
      const versionId = row.agentVersionId ?? null;
      const bucket = byVersion.get(versionId) ?? {
        turnCount: 0,
        usage: { ...EMPTY_USAGE },
        latencySumMs: 0,
        latencyCount: 0,
        errorCount: 0,
      };
      bucket.turnCount += 1;
      bucket.usage = addUsage(bucket.usage, usageFromTurn(row as any));
      if (row.startedAt && row.completedAt) {
        bucket.latencySumMs += row.completedAt.getTime() - row.startedAt.getTime();
        bucket.latencyCount += 1;
      }
      if (!row.outputText) bucket.errorCount += 1;
      byVersion.set(versionId, bucket);
    }
    const perVersion = Array.from(byVersion.entries()).map(([versionId, bucket]) => ({
      versionId,
      versionNumber: versionId ? versionNumberById.get(versionId) ?? null : null,
      isCurrent: versionId === binding.activeAgentVersionId,
      isCanary: versionId === binding.canaryAgentVersionId,
      // Turns attempted against this version, and completed turns among them.
      // A version that fails half its turns should not look half as expensive
      // AND half as busy at the same rate.
      turnCount: bucket.turnCount,
      tasks: bucket.usage.tasks,
      totalCostCents: roundCents(bucket.usage.costCents),
      inputTokens: bucket.usage.inputTokens,
      outputTokens: bucket.usage.outputTokens,
      avgLatencyMs: bucket.latencyCount ? Math.round(bucket.latencySumMs / bucket.latencyCount) : null,
      errorCount: bucket.errorCount,
      errorRate: bucket.turnCount ? bucket.errorCount / bucket.turnCount : 0,
    }));
    perVersion.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.isCanary !== b.isCanary) return a.isCanary ? -1 : 1;
      return b.turnCount - a.turnCount;
    });
    return {
      hours,
      currentVersionId: binding.activeAgentVersionId,
      canaryVersionId: binding.canaryAgentVersionId ?? null,
      canaryPercent: binding.canaryPercent ?? 0,
      perVersion,
    };
  }

  private async invalidate(agentId: string, scope: RequestScope): Promise<void> {
    await this.redis.del(
      `agent:${agentId}:config`,
      `agent:${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${agentId}:config`,
    );
    this.promptCache?.invalidate(agentId).catch(() => undefined);
  }
}
