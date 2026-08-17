import type { Prisma } from "../generated/control";

export type JsonRoot = "object" | "array" | "objectOrArray";

export interface JsonShapeDefinition {
  readonly root: JsonRoot;
  readonly legacyEncodedLayer: boolean;
  readonly description: string;
}

const object = (description: string, legacyEncodedLayer = false): JsonShapeDefinition => ({
  root: "object",
  legacyEncodedLayer,
  description,
});
const array = (description: string, legacyEncodedLayer = false): JsonShapeDefinition => ({
  root: "array",
  legacyEncodedLayer,
  description,
});
const objectOrArray = (description: string): JsonShapeDefinition => ({
  root: "objectOrArray",
  legacyEncodedLayer: false,
  description,
});

/**
 * Complete write-boundary contract for every Json field in schema.prisma.
 * Optional columns are omitted with `undefined`; JSON null is not a substitute
 * for an absent value. Only the four explicitly marked legacy fields may parse
 * one encoded JSON layer.
 */
export const jsonShapeRegistry = {
  "User.dashboardPreferences": object("Versioned dashboard navigation preferences."),
  "EndUserIdentity.profile": object("Verified identity profile attributes."),
  "AgentCluster.metadata": object("Non-secret cluster labels."),
  "AgentVersion.promptBlocks": array("PromptBlock objects.", true),
  "AgentVersion.dynamicBlocks": array("DynamicBlock objects.", true),
  "AgentVersion.toolsBlockConfig": object("Typed tool rendering and invocation settings.", true),
  "AgentVersion.modelRoutes": array("ModelRoute objects.", true),
  "AgentVersion.memoryConfig": object("Memory limits and visibility defaults."),
  "AgentVersion.outputSchema": object("JSON Schema for structured model output."),
  "PostmanTemplate.sessionContext": object("Request and session variables."),
  "Thread.sessionContext": object("Verified channel context."),
  "Turn.input": object("Structured accepted turn input."),
  "Turn.output": object("Structured final turn output."),
  "ToolCall.arguments": object("Validated tool arguments."),
  "ToolCall.result": objectOrArray("Structured tool result."),
  "Artifact.metadata": object("Non-secret artifact attributes."),
  "ChannelConnection.agentRouting": array("Typed channel routing rules."),
  "ChannelApp.agentRouting": array("Typed channel routing rules."),
  "ChannelInstallation.agentRouting": array("Typed channel routing rules."),
  "EntityMcpConfig.identityProviders": array("Identity provider descriptors."),
  "EntityMcpConfig.branding": object("Public branding values."),
  "EntityMcpClient.headersTemplate": object("Non-secret outbound header templates."),
  "Tool.paramSchema": object("JSON Schema for tool parameters."),
  "ToolCallAudit.arguments": object("Redacted tool arguments."),
  "ToolCallAudit.result": objectOrArray("Redacted structured tool result."),
  "AdminAudit.before": object("Redacted previous state."),
  "AdminAudit.after": object("Redacted resulting state."),
  "ExternalCutoverRun.report": object("Validated redacted STUB or disposable-rehearsal external cutover report."),
  "ExternalCutoverEvidence.expectedMetadata": object("Expected external counts and SHA-256 digests."),
  "ExternalCutoverEvidence.observedMetadata": object("Observed external counts and SHA-256 digests."),
  "ObjectKeyReconciliation.expectedMetadata": object("Expected object byte count and content digest."),
  "ObjectKeyReconciliation.observedMetadata": object("Observed object byte count and content digest."),
  "AgentApproval.arguments": object("Proposed tool or action arguments."),
  "AgentApproval.resolution": object("Approval resolution details."),
  "Budget.alertThresholds": array("Integer percentage thresholds."),
  "SafetyEvent.metadata": object("Redacted detector attributes."),
  "AgentEval.criterionSnapshot": object("Immutable criterion snapshot."),
  "Job.payloadSchema": object("JSON Schema for job input."),
  "Skill.manifest": object("Typed skill manifest."),
  "Skill.providesTools": array("Tool descriptors supplied by the skill."),
  "EnvironmentSkill.config": object("Environment-specific skill configuration."),
  "AgentSkill.config": object("Agent-version skill configuration."),
  "Memory.metadata": object("Memory extraction and source attributes."),
  "MemoryEntity.metadata": object("Extracted entity attributes."),
  "MemoryRelationship.metadata": object("Extracted relationship attributes."),
  "Macro.steps": array("Typed macro step objects."),
  "Macro.paramSchema": object("JSON Schema for macro parameters."),
  "Event.payload": object("Versioned event body."),
  "NotificationRule.filters": object("Typed event predicates."),
  "NotificationRule.delivery": object("Typed non-secret destination configuration."),
  "ErasureOperation.scopes": array("Normalized subject scope descriptors."),
  "ErasureOperation.stores": array("Storage-system erasure outcomes."),
  "ErasureOperation.inventory": object("Non-identifying row inventory."),
} as const satisfies Record<string, JsonShapeDefinition>;

export type JsonField = keyof typeof jsonShapeRegistry;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;

export class JsonShapeError extends TypeError {
  constructor(field: JsonField, message: string) {
    super(`${field}: ${message}`);
    this.name = "JsonShapeError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonValue(
  field: JsonField,
  value: unknown,
  path: string = field
): asserts value is JsonValue {
  if (value === null) {
    if (path === field) throw new JsonShapeError(field, "root cannot be null");
    return;
  }
  if (value === undefined) {
    throw new JsonShapeError(field, `${path} cannot contain undefined`);
  }
  if (["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(field, entry, `${path}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(field, entry, `${path}.${key}`);
    }
    return;
  }
  throw new JsonShapeError(field, `${path} is not a JSON value`);
}

/** Normalizes and validates a value before it reaches any Prisma Json write. */
export function normalizeJsonField(field: JsonField, input: unknown): Prisma.InputJsonValue {
  const definition = jsonShapeRegistry[field];
  let value = input;

  if (typeof value === "string" && definition.legacyEncodedLayer) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new JsonShapeError(field, "legacy encoded value is malformed JSON");
    }
  }

  const validRoot =
    definition.root === "array"
      ? Array.isArray(value)
      : definition.root === "object"
        ? isObject(value)
        : Array.isArray(value) || isObject(value);
  if (!validRoot) {
    throw new JsonShapeError(field, `expected ${definition.root} root`);
  }

  // If one parse produced another string, the root check above rejects it. A
  // second parse is deliberately never attempted, preventing double encoding.
  assertJsonValue(field, value);
  return value as Prisma.InputJsonValue;
}

export interface PromptBlock {
  id: string;
  type: string;
  name: string;
  content: string;
  enabled: boolean;
  editable: boolean;
  order: number;
}

export interface DynamicBlock {
  key: string;
  name: string;
  defaultContent: string;
  description?: string;
  order?: number;
}

export interface ModelRoute {
  label: string;
  model: string;
  providerCredentialId?: string;
  isDefault: boolean;
}

export interface ToolsBlockConfig {
  mode?: "direct" | "sub-agent" | "execute-tool";
  toolExposure?: "direct" | "meta";
  displayMode?: "full" | "summary" | "meta-tool" | "hybrid";
  pinnedTools?: string[];
  enabledCategories?: string[];
  entityIdsRequired?: boolean;
}

export type DashboardPreferences = Prisma.InputJsonObject & {
  version: "1";
  currentProjectId?: string;
  projects: Record<string, { currentEnvironment: { id: string } }>;
  sideMenu?: {
    isCollapsed?: boolean;
    collapsedSections?: Record<string, boolean>;
    organizations?: Record<string, { orderedItems: Record<string, string[]> }>;
  };
};

function requireNonEmptyString(field: JsonField, value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JsonShapeError(field, `${path} must be a non-empty string`);
  }
  return value;
}

function requireRecord(field: JsonField, value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new JsonShapeError(field, `${path} must be an object`);
  return value;
}

/** Normalizes the inherited version-1 dashboard preference contract. */
export function normalizeDashboardPreferences(input: unknown): DashboardPreferences {
  const field = "User.dashboardPreferences" as const;
  const root = normalizeJsonField(field, input) as Record<string, unknown>;
  if (root.version !== "1") throw new JsonShapeError(field, "version must be \"1\"");

  const projectsInput = requireRecord(field, root.projects, "projects");
  const projects = Object.fromEntries(Object.entries(projectsInput).map(([projectId, value]) => {
    requireNonEmptyString(field, projectId, "projects key");
    const project = requireRecord(field, value, `projects.${projectId}`);
    const currentEnvironment = requireRecord(
      field,
      project.currentEnvironment,
      `projects.${projectId}.currentEnvironment`
    );
    return [projectId, {
      currentEnvironment: {
        id: requireNonEmptyString(
          field,
          currentEnvironment.id,
          `projects.${projectId}.currentEnvironment.id`
        ),
      },
    }];
  }));

  const normalized: DashboardPreferences = { version: "1", projects };
  if (root.currentProjectId !== undefined) {
    normalized.currentProjectId = requireNonEmptyString(
      field,
      root.currentProjectId,
      "currentProjectId"
    );
  }

  if (root.sideMenu !== undefined) {
    const sideMenuInput = requireRecord(field, root.sideMenu, "sideMenu");
    const sideMenu: NonNullable<DashboardPreferences["sideMenu"]> = {};
    if (sideMenuInput.isCollapsed !== undefined) {
      if (typeof sideMenuInput.isCollapsed !== "boolean") {
        throw new JsonShapeError(field, "sideMenu.isCollapsed must be a boolean");
      }
      sideMenu.isCollapsed = sideMenuInput.isCollapsed;
    }
    if (sideMenuInput.collapsedSections !== undefined) {
      const sections = requireRecord(
        field,
        sideMenuInput.collapsedSections,
        "sideMenu.collapsedSections"
      );
      for (const [section, collapsed] of Object.entries(sections)) {
        requireNonEmptyString(field, section, "sideMenu.collapsedSections key");
        if (typeof collapsed !== "boolean") {
          throw new JsonShapeError(
            field,
            `sideMenu.collapsedSections.${section} must be a boolean`
          );
        }
      }
      sideMenu.collapsedSections = sections as Record<string, boolean>;
    }
    if (sideMenuInput.organizations !== undefined) {
      const organizations = requireRecord(
        field,
        sideMenuInput.organizations,
        "sideMenu.organizations"
      );
      sideMenu.organizations = Object.fromEntries(Object.entries(organizations).map(
        ([organizationId, value]) => {
          requireNonEmptyString(field, organizationId, "sideMenu.organizations key");
          const organization = requireRecord(
            field,
            value,
            `sideMenu.organizations.${organizationId}`
          );
          const orderedItems = requireRecord(
            field,
            organization.orderedItems,
            `sideMenu.organizations.${organizationId}.orderedItems`
          );
          for (const [listId, order] of Object.entries(orderedItems)) {
            requireNonEmptyString(field, listId, "sideMenu orderedItems key");
            if (!Array.isArray(order) || order.some((entry) => typeof entry !== "string")) {
              throw new JsonShapeError(
                field,
                `sideMenu.organizations.${organizationId}.orderedItems.${listId} must be an array of strings`
              );
            }
          }
          return [organizationId, {
            orderedItems: orderedItems as Record<string, string[]>,
          }];
        }
      ));
    }
    normalized.sideMenu = sideMenu;
  }
  return normalized;
}

function requireObjectEntries(field: JsonField, value: Prisma.InputJsonValue): Record<string, unknown>[] {
  return (value as unknown[]).map((entry, index) => {
    if (!isObject(entry)) throw new JsonShapeError(field, `entry ${index} must be an object`);
    return entry;
  });
}

function requireString(field: JsonField, entry: Record<string, unknown>, key: string, index: number) {
  if (typeof entry[key] !== "string" || entry[key] === "") {
    throw new JsonShapeError(field, `entry ${index}.${key} must be a non-empty string`);
  }
}

export function normalizePromptBlocks(input: unknown): PromptBlock[] {
  const field = "AgentVersion.promptBlocks" as const;
  return requireObjectEntries(field, normalizeJsonField(field, input)).map((entry, index) => {
    for (const key of ["id", "type", "name", "content"]) requireString(field, entry, key, index);
    if (typeof entry.enabled !== "boolean" || typeof entry.editable !== "boolean") {
      throw new JsonShapeError(field, `entry ${index} enabled/editable must be booleans`);
    }
    if (!Number.isInteger(entry.order)) {
      throw new JsonShapeError(field, `entry ${index}.order must be an integer`);
    }
    return entry as unknown as PromptBlock;
  });
}

export function normalizeDynamicBlocks(input: unknown): DynamicBlock[] {
  const field = "AgentVersion.dynamicBlocks" as const;
  return requireObjectEntries(field, normalizeJsonField(field, input)).map((entry, index) => {
    for (const key of ["key", "name", "defaultContent"]) requireString(field, entry, key, index);
    if (entry.description !== undefined && typeof entry.description !== "string") {
      throw new JsonShapeError(field, `entry ${index}.description must be a string`);
    }
    if (entry.order !== undefined && !Number.isInteger(entry.order)) {
      throw new JsonShapeError(field, `entry ${index}.order must be an integer`);
    }
    return entry as unknown as DynamicBlock;
  });
}

export function normalizeModelRoutes(input: unknown): ModelRoute[] {
  const field = "AgentVersion.modelRoutes" as const;
  const labels = new Set<string>();
  let defaults = 0;
  const routes = requireObjectEntries(field, normalizeJsonField(field, input)).map((entry, index) => {
    requireString(field, entry, "label", index);
    requireString(field, entry, "model", index);
    if (entry.providerCredentialId !== undefined && typeof entry.providerCredentialId !== "string") {
      throw new JsonShapeError(field, `entry ${index}.providerCredentialId must be a string`);
    }
    if (typeof entry.isDefault !== "boolean") {
      throw new JsonShapeError(field, `entry ${index}.isDefault must be a boolean`);
    }
    if (labels.has(entry.label as string)) {
      throw new JsonShapeError(field, `duplicate route label ${entry.label as string}`);
    }
    labels.add(entry.label as string);
    if (entry.isDefault) defaults += 1;
    return entry as unknown as ModelRoute;
  });
  if (routes.length > 0 && defaults !== 1) {
    throw new JsonShapeError(field, "exactly one non-empty route must be the default");
  }
  return routes;
}

function optionalStringArray(field: JsonField, config: Record<string, unknown>, key: string) {
  const value = config[key];
  if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
    throw new JsonShapeError(field, `${key} must be an array of strings`);
  }
}

export function normalizeToolsBlockConfig(input: unknown): ToolsBlockConfig {
  const field = "AgentVersion.toolsBlockConfig" as const;
  const config = normalizeJsonField(field, input) as Record<string, unknown>;
  if ("enabledTools" in config) {
    throw new JsonShapeError(
      field,
      "enabledTools is retired; write explicit AgentToolPolicy relations instead"
    );
  }
  const enums = {
    mode: ["direct", "sub-agent", "execute-tool"],
    toolExposure: ["direct", "meta"],
    displayMode: ["full", "summary", "meta-tool", "hybrid"],
  } as const;
  for (const [key, allowed] of Object.entries(enums)) {
    const value = config[key];
    if (value !== undefined && !allowed.includes(value as never)) {
      throw new JsonShapeError(field, `${key} has an unsupported value`);
    }
  }
  optionalStringArray(field, config, "pinnedTools");
  optionalStringArray(field, config, "enabledCategories");
  if (config.entityIdsRequired !== undefined && typeof config.entityIdsRequired !== "boolean") {
    throw new JsonShapeError(field, "entityIdsRequired must be a boolean");
  }
  return config as ToolsBlockConfig;
}

/** Builds the only accepted Json payload for an AgentVersion create/update. */
export function normalizeAgentVersionJson(input: {
  promptBlocks: unknown;
  dynamicBlocks: unknown;
  toolsBlockConfig: unknown;
  modelRoutes: unknown;
  memoryConfig?: unknown;
  outputSchema?: unknown;
}) {
  return {
    promptBlocks: normalizePromptBlocks(input.promptBlocks),
    dynamicBlocks: normalizeDynamicBlocks(input.dynamicBlocks),
    toolsBlockConfig: normalizeToolsBlockConfig(input.toolsBlockConfig),
    modelRoutes: normalizeModelRoutes(input.modelRoutes),
    ...(input.memoryConfig === undefined
      ? {}
      : { memoryConfig: normalizeJsonField("AgentVersion.memoryConfig", input.memoryConfig) }),
    ...(input.outputSchema === undefined
      ? {}
      : { outputSchema: normalizeJsonField("AgentVersion.outputSchema", input.outputSchema) }),
  };
}
