// The seven `agents` rows, as they come back from PostgreSQL.
//
// One module for all seven because they are one mapping decision repeated seven
// times: a column shape in, a domain record out, and NOTHING invented on the way
// through. A row that cannot be read is a defect in the store or in a migration,
// so the two readers that can fail throw `UnreadableAgentsRowError` rather than
// returning a plausible default — the same choice `mapping.ts` makes for a role
// the schema no longer has.
//
// THE VERSION IS THE ONLY ONE THAT IS NOT A FIELD COPY. `AgentVersion` has nine
// columns plus a reserved `__runtime` key inside `memoryConfig`, and
// `domain/version-envelope.ts` owns the whole of that arrangement. This module
// calls `readVersionRow` and does not restate it: a second copy of "which field
// lives in the envelope" is exactly the drift that shows an operator a blob of
// internal state or silently strips a live agent's carried configuration.
//
// `Date` IS RETURNED AS THE DRIVER GIVES IT. The columns are `timestamp` and the
// client hands back a `Date`; re-wrapping it would be a place a timezone could
// be introduced.

import type {
  ActorId,
  Agent,
  AgentBinding,
  AgentBindingId,
  AgentCluster,
  AgentClusterId,
  AgentDefaultsPolicy,
  AgentId,
  AgentSkill,
  AgentSkillId,
  AgentVersion,
  AgentVersionId,
  EnvironmentId,
  EnvironmentSkillId,
  JsonObject,
  Macro,
  MacroId,
  MacroStep,
  PostmanTemplate,
  PostmanTemplateId,
  ProjectId,
  Slug,
  ToolDefaultPolicy,
} from "@platos/context-agents/application/ports/index.js";
import { readVersionRow } from "@platos/context-agents/application/ports/index.js";

/** A stored row carries a shape this adapter cannot read. */
export const UNREADABLE_AGENTS_ROW = "agents.adapter.unreadable_row";

export class UnreadableAgentsRowError extends Error {
  readonly code = UNREADABLE_AGENTS_ROW;
  readonly column: string;

  constructor(column: string, message: string) {
    super(message);
    this.name = "UnreadableAgentsRowError";
    this.column = column;
  }
}

const TOOL_DEFAULT_POLICIES = new Set<string>(["NONE", "ALL"]);

/**
 * Tag an already-provenanced string.
 *
 * `asAgentsIdentifier` is the domain's own assertion and takes a branded target;
 * every identifier below is one, but naming each brand at each call site would be
 * forty annotations for one decision. This narrows once, here, and is the only
 * unchecked cast in the module.
 */
function tag<Id extends string>(value: string): Id {
  return value as unknown as Id;
}

/** A JSONB column the migrations pin to an object root, or null. */
function objectColumn(value: unknown): JsonObject | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

export interface AgentRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toAgent(row: AgentRow): Agent {
  return {
    agentId: tag<AgentId>(row.id),
    projectId: tag<ProjectId>(row.projectId),
    name: row.name,
    slug: tag<Slug>(row.slug),
    description: row.description,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface AgentBindingRow {
  readonly id: string;
  readonly environmentId: string;
  readonly agentId: string;
  readonly activeAgentVersionId: string;
  readonly canaryAgentVersionId: string | null;
  readonly clusterId: string | null;
  readonly canaryPercent: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toBinding(row: AgentBindingRow): AgentBinding {
  return {
    agentBindingId: tag<AgentBindingId>(row.id),
    environmentId: tag<EnvironmentId>(row.environmentId),
    agentId: tag<AgentId>(row.agentId),
    activeVersionId: tag<AgentVersionId>(row.activeAgentVersionId),
    canaryVersionId:
      row.canaryAgentVersionId === null ? null : tag<AgentVersionId>(row.canaryAgentVersionId),
    clusterId: row.clusterId === null ? null : tag<AgentClusterId>(row.clusterId),
    canaryPercent: row.canaryPercent,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface AgentClusterRow {
  readonly id: string;
  readonly environmentId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly metadata: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toCluster(row: AgentClusterRow): AgentCluster {
  return {
    clusterId: tag<AgentClusterId>(row.id),
    environmentId: tag<EnvironmentId>(row.environmentId),
    name: row.name,
    slug: tag<Slug>(row.slug),
    description: row.description,
    metadata: objectColumn(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface AgentVersionRowShape {
  readonly id: string;
  readonly agentId: string;
  readonly versionNumber: number;
  readonly model: string;
  readonly systemPrompt: string | null;
  readonly maxSteps: number;
  readonly contextLimit: number;
  readonly toolDefaultPolicy: string;
  readonly promptBlocks: unknown;
  readonly dynamicBlocks: unknown;
  readonly toolsBlockConfig: unknown;
  readonly modelRoutes: unknown;
  readonly memoryConfig: unknown;
  readonly outputSchema: unknown;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
}

/**
 * A stored version, read back through the domain's own envelope.
 *
 * `toolDefaultPolicy` is the one column with a closed set behind it. The schema
 * declares it as an enum, so a value outside the set means the enum and the
 * domain have diverged — a migration this adapter has not been told about — and
 * defaulting it to `NONE` would silently expose no tools where a version said
 * `ALL`, or the reverse.
 */
export function toVersion(row: AgentVersionRowShape, defaults: AgentDefaultsPolicy): AgentVersion {
  if (!TOOL_DEFAULT_POLICIES.has(row.toolDefaultPolicy)) {
    throw new UnreadableAgentsRowError(
      "AgentVersion.toolDefaultPolicy",
      `AgentVersion ${row.id} carries tool default policy "${row.toolDefaultPolicy}", which the domain does not name`,
    );
  }
  return {
    agentVersionId: tag<AgentVersionId>(row.id),
    agentId: tag<AgentId>(row.agentId),
    versionNumber: row.versionNumber,
    toolDefaultPolicy: row.toolDefaultPolicy as ToolDefaultPolicy,
    note: row.note,
    createdBy: tag<ActorId>(row.createdBy),
    createdAt: row.createdAt,
    snapshot: readVersionRow(
      {
        model: row.model,
        systemPrompt: row.systemPrompt,
        maxSteps: row.maxSteps,
        contextLimit: row.contextLimit,
        promptBlocks: row.promptBlocks,
        dynamicBlocks: row.dynamicBlocks,
        toolsBlockConfig: row.toolsBlockConfig,
        modelRoutes: row.modelRoutes,
        memoryConfig: row.memoryConfig,
        outputSchema: row.outputSchema,
      },
      defaults,
    ),
  };
}

export interface AgentSkillRow {
  readonly id: string;
  readonly agentVersionId: string;
  readonly environmentSkillId: string;
  readonly enabled: boolean;
  readonly config: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toSkill(row: AgentSkillRow): AgentSkill {
  return {
    agentSkillId: tag<AgentSkillId>(row.id),
    agentVersionId: tag<AgentVersionId>(row.agentVersionId),
    environmentSkillId: tag<EnvironmentSkillId>(row.environmentSkillId),
    enabled: row.enabled,
    config: objectColumn(row.config) ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface MacroRow {
  readonly id: string;
  readonly environmentId: string;
  readonly name: string;
  readonly description: string | null;
  readonly steps: unknown;
  readonly paramSchema: unknown;
  readonly sharedWithOrganization: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A macro's steps, read out of the array the migrations pin the column to.
 *
 * `Macro_steps_json_root` guarantees an ARRAY and says nothing about what is
 * inside it, so an element that is not `{tool, params}` is a real possibility
 * and is refused rather than coerced into `{tool: "", params: {}}` — a step with
 * an empty tool name would replay as a silent no-op.
 */
export function toMacroSteps(id: string, value: unknown): readonly MacroStep[] {
  if (!Array.isArray(value)) {
    throw new UnreadableAgentsRowError("Macro.steps", `Macro ${id} carries steps that are not an array`);
  }
  return value.map((element, index) => {
    const step = objectColumn(element);
    const tool = step === null ? undefined : step["tool"];
    if (typeof tool !== "string" || tool === "") {
      throw new UnreadableAgentsRowError(
        "Macro.steps",
        `Macro ${id} step ${index} names no tool`,
      );
    }
    return { tool, params: objectColumn(step?.["params"]) ?? {} };
  });
}

export function toMacro(row: MacroRow): Macro {
  return {
    macroId: tag<MacroId>(row.id),
    environmentId: tag<EnvironmentId>(row.environmentId),
    name: row.name,
    description: row.description,
    steps: toMacroSteps(row.id, row.steps),
    paramSchema: objectColumn(row.paramSchema),
    sharedWithOrganization: row.sharedWithOrganization,
    createdBy: tag<ActorId>(row.createdBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface PostmanTemplateRow {
  readonly id: string;
  readonly environmentId: string;
  readonly agentId: string;
  readonly name: string;
  readonly simulateUserId: string;
  readonly sessionContext: unknown;
  readonly isDefault: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toTemplate(row: PostmanTemplateRow): PostmanTemplate {
  return {
    templateId: tag<PostmanTemplateId>(row.id),
    environmentId: tag<EnvironmentId>(row.environmentId),
    agentId: tag<AgentId>(row.agentId),
    name: row.name,
    simulateUserId: row.simulateUserId,
    sessionContext: objectColumn(row.sessionContext),
    isDefault: row.isDefault,
    createdBy: tag<ActorId>(row.createdBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
