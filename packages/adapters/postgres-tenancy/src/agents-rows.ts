// The seven `agents` rows, as they come back from PostgreSQL.
//
// One module for all seven because they are one mapping decision repeated seven
// times: a column shape in, a domain record out, and NOTHING invented on the way
// through. A row that cannot be read is a defect in the store or in a migration,
// so the readers that can fail throw `UnreadableAgentsRowError` rather than
// returning a plausible default — the same choice `mapping.ts` makes for a role
// the schema no longer has. Each of them carries its OWN code: see the four
// constants below and why they are four.
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

/** A stored row carries a value outside a closed set this adapter names. */
export const UNREADABLE_AGENTS_ROW = "agents.adapter.unreadable_row";

/**
 * The four codes below are FOUR, not one.
 *
 * WIN-258 T7. `UnreadableAgentsRowError` used to carry one code and a column
 * name, which made two of these indistinguishable to anything reading the code:
 * a macro whose steps are not an array and a macro whose step names no tool both
 * arrived as `unreadable_row` on column `Macro.steps`. An operator cannot act on
 * the pair — the first is a column written by something that is not this store,
 * the second is one bad element in an otherwise readable table — so they are two
 * codes and the column is left to say WHERE rather than WHAT.
 */
export const AGENTS_COLUMN_NOT_AN_OBJECT = "agents.adapter.column_not_an_object";

/** `Macro.steps` holds something that is not a JSON array. */
export const MACRO_STEPS_NOT_AN_ARRAY = "agents.adapter.macro_steps_not_an_array";

/** One element of `Macro.steps` names no tool to replay. */
export const MACRO_STEP_NAMES_NO_TOOL = "agents.adapter.macro_step_names_no_tool";

/** One element of `Macro.steps` carries params that are not an object. */
export const MACRO_STEP_PARAMS_NOT_AN_OBJECT = "agents.adapter.macro_step_params_not_an_object";

export class UnreadableAgentsRowError extends Error {
  readonly code: string;
  readonly column: string;

  constructor(code: string, column: string, message: string) {
    super(message);
    this.name = "UnreadableAgentsRowError";
    this.code = code;
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

/**
 * A JSONB column the migrations pin to an object root, or null.
 *
 * WIN-258 T7 MADE THIS REFUSE. It used to answer `null` for a value that was
 * not an object, which every caller then turned into `null` or `{}` — so an
 * `AgentSkill.config` holding an array ran the skill UNCONFIGURED and said
 * nothing, and a `PostmanTemplate.sessionContext` holding one replayed a turn
 * with no context at all. The root is pinned by `<Model>_<column>_json_root`,
 * so at the top of a column this refusal is unreachable and the CHECK is the
 * evidence; it is reachable, and proved reachable, on the INTERIOR value
 * `toMacroSteps` hands it, where no CHECK reaches.
 */
export function readObjectColumn(column: string, where: string, value: unknown): JsonObject | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new UnreadableAgentsRowError(
      AGENTS_COLUMN_NOT_AN_OBJECT,
      column,
      `${where} carries ${Array.isArray(value) ? "a JSON array" : typeof value} where ${column} is an object`,
    );
  }
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
    metadata: readObjectColumn("AgentCluster.metadata", `AgentCluster ${row.id}`, row.metadata),
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
      UNREADABLE_AGENTS_ROW,
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
    config: readObjectColumn("AgentSkill.config", `AgentSkill ${row.id}`, row.config) ?? {},
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
 *
 * *** `params` IS THE ONE PLACE IN THIS PACKAGE WHERE A COERCION WAS REACHABLE.
 * WIN-258 T7 found it. `{"tool": "send", "params": ["a"]}` satisfies the CHECK —
 * the ROOT is an array and the CHECK says nothing about the elements — and the
 * old reader answered `{}` for it, so the macro replayed `send` WITH NO
 * PARAMETERS and reported success. An ABSENT `params` is still `{}`, because a
 * step that states none has none; a PRESENT `params` that is not an object is a
 * different fact and is now named.
 */
export function toMacroSteps(id: string, value: unknown): readonly MacroStep[] {
  if (!Array.isArray(value)) {
    throw new UnreadableAgentsRowError(
      MACRO_STEPS_NOT_AN_ARRAY,
      "Macro.steps",
      `Macro ${id} carries steps that are not an array`,
    );
  }
  return value.map((element, index) => {
    const step =
      typeof element === "object" && element !== null && !Array.isArray(element)
        ? (element as JsonObject)
        : null;
    const tool = step === null ? undefined : step["tool"];
    if (step === null || typeof tool !== "string" || tool === "") {
      throw new UnreadableAgentsRowError(
        MACRO_STEP_NAMES_NO_TOOL,
        "Macro.steps",
        `Macro ${id} step ${index} names no tool`,
      );
    }
    const params = step["params"];
    if (params === null || params === undefined) return { tool, params: {} };
    if (typeof params !== "object" || Array.isArray(params)) {
      throw new UnreadableAgentsRowError(
        MACRO_STEP_PARAMS_NOT_AN_OBJECT,
        "Macro.steps",
        `Macro ${id} step ${index} carries ${Array.isArray(params) ? "a JSON array" : typeof params} where params is an object`,
      );
    }
    return { tool, params: params as JsonObject };
  });
}

export function toMacro(row: MacroRow): Macro {
  return {
    macroId: tag<MacroId>(row.id),
    environmentId: tag<EnvironmentId>(row.environmentId),
    name: row.name,
    description: row.description,
    steps: toMacroSteps(row.id, row.steps),
    paramSchema: readObjectColumn("Macro.paramSchema", `Macro ${row.id}`, row.paramSchema),
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
    sessionContext: readObjectColumn(
      "PostmanTemplate.sessionContext",
      `PostmanTemplate ${row.id}`,
      row.sessionContext,
    ),
    isDefault: row.isDefault,
    createdBy: tag<ActorId>(row.createdBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * THE COLUMN MAPS, one per row interface above, named to the client on every read.
 *
 * WIN-258 T7 ADDED THEM. Every read in this context already asserted its rows
 * `as <Something>Row`, and an unprojected read makes that assertion a CLAIM
 * about a table rather than a fact about a statement: whatever column the next
 * migration adds arrives in the row, is carried into the domain object by
 * nothing, and is deserialised on every listing for as long as it exists. That
 * matters most here because this context holds NINE of the forty-nine JSONB
 * columns — six of them on `AgentVersion` alone, and a bound agent carries TWO
 * versions — so over-reading a listing of twenty agents is two hundred and forty
 * documents nobody asked for.
 *
 * THEY LIVE BESIDE THE ROW INTERFACES THEY MIRROR, not beside the reads, because
 * a map and an interface that disagree is precisely the drift the assertion
 * hides. `agents-statements.integration.test.ts` pins the SELECT list each one
 * produces against the real driver.
 */
export const AGENT_COLUMNS = {
  id: true,
  projectId: true,
  name: true,
  slug: true,
  description: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const BINDING_COLUMNS = {
  id: true,
  environmentId: true,
  agentId: true,
  activeAgentVersionId: true,
  canaryAgentVersionId: true,
  clusterId: true,
  canaryPercent: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const CLUSTER_COLUMNS = {
  id: true,
  environmentId: true,
  name: true,
  slug: true,
  description: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const VERSION_COLUMNS = {
  id: true,
  agentId: true,
  versionNumber: true,
  model: true,
  systemPrompt: true,
  maxSteps: true,
  contextLimit: true,
  toolDefaultPolicy: true,
  promptBlocks: true,
  dynamicBlocks: true,
  toolsBlockConfig: true,
  modelRoutes: true,
  memoryConfig: true,
  outputSchema: true,
  note: true,
  createdBy: true,
  createdAt: true,
} as const;

export const SKILL_COLUMNS = {
  id: true,
  agentVersionId: true,
  environmentSkillId: true,
  enabled: true,
  config: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const MACRO_COLUMNS = {
  id: true,
  environmentId: true,
  name: true,
  description: true,
  steps: true,
  paramSchema: true,
  sharedWithOrganization: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const TEMPLATE_COLUMNS = {
  id: true,
  environmentId: true,
  agentId: true,
  name: true,
  simulateUserId: true,
  sessionContext: true,
  isDefault: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;
