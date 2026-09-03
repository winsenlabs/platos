// Turning this context's aggregates into the shapes its contract publishes.
//
// The whole reason a view type exists is here. A `BoundAgent` is three rows and
// a snapshot; a caller outside this context wants ONE agent, with the version's
// configuration folded in and the binding's own ids visible as the two facts a
// surface actually renders — which version is live and which is in canary.
//
// TWO THINGS THE VIEWS DELIBERATELY WITHHOLD.
//
//   THE `__runtime` ENVELOPE. `AgentVersion.memoryConfig` carries carried state
//   under a reserved key. The projection reads it (that is what
//   `readVersionRow` is for) and never re-emits it: a settings panel showing an
//   operator a blob of internal fields is how the envelope leaks, and once one
//   surface renders it the next one saves it back.
//
//   THE SNAPSHOT'S IDENTITY. A view carries the version's number and note, not
//   its row id anywhere the id is not already meaningful. The two places it IS
//   meaningful — `currentVersionId` and `canaryVersionId` — are the ones a
//   canary control has to name.

import type {
  AgentVersion,
  AgentVersionSnapshot,
  Macro,
  ModelRoute,
  PostmanTemplate,
  SkillAssignment,
} from "../domain/index.js";
import type {
  AgentSkillView,
  AgentVersionView,
  AgentView,
  MacroView,
  ModelRouteView,
  PostmanTemplateView,
} from "../contracts/index.js";
import type { BoundAgent } from "./ports/index.js";
import type { VersionInHistory } from "./version-history.js";
import type { VisibleMacro } from "./macros.js";

function toRouteView(route: ModelRoute): ModelRouteView {
  return {
    label: route.label,
    model: route.model,
    providerKeyId: route.providerKeyId,
    isDefault: route.isDefault,
  };
}

function toSnapshotView(snapshot: AgentVersionSnapshot): AgentVersionView["configuration"] {
  return {
    model: snapshot.model,
    modelRoutes: snapshot.modelRoutes === null ? null : snapshot.modelRoutes.map(toRouteView),
    systemPrompt: snapshot.systemPrompt,
    promptBlocks: snapshot.promptBlocks,
    dynamicBlocks: snapshot.dynamicBlocks,
    maxSteps: snapshot.maxSteps,
    contextLimit: snapshot.contextLimit,
    historyMode: snapshot.historyMode,
    compactThreshold: snapshot.compactThreshold,
    enableUserProfiling: snapshot.enableUserProfiling,
    toolMode: snapshot.toolMode,
    executionMode: snapshot.executionMode,
    toolsBlockConfig: snapshot.toolsBlockConfig,
    subAgentConfig: snapshot.subAgentConfig,
    memoryConfig: snapshot.memoryConfig,
    metaTools: snapshot.metaTools,
    featureFlags: snapshot.featureFlags,
    outputSchema: snapshot.outputSchema,
    extractionPolicy: snapshot.extractionPolicy,
    enableThreading: snapshot.enableThreading,
    threadingConfig: snapshot.threadingConfig,
    contextMapping: snapshot.contextMapping,
    providerKeyId: snapshot.providerKeyId,
    visibility: snapshot.visibility,
    maxJobsPerTurn: snapshot.maxJobsPerTurn,
    agentRetryConfig: snapshot.agentRetryConfig,
  };
}

export function toAgentView(bound: BoundAgent): AgentView {
  return {
    agentId: bound.agent.agentId,
    projectId: bound.agent.projectId,
    environmentId: bound.binding.environmentId,
    name: bound.agent.name,
    slug: bound.agent.slug,
    description: bound.agent.description,
    isActive: bound.agent.isActive,
    clusterId: bound.binding.clusterId,
    currentVersionId: bound.binding.activeVersionId,
    currentVersionNumber: bound.activeVersion.versionNumber,
    canaryVersionId: bound.binding.canaryVersionId,
    canaryVersionNumber: bound.canaryVersion?.versionNumber ?? null,
    canaryPercent: bound.binding.canaryPercent,
    configuration: toSnapshotView(bound.activeVersion.snapshot),
    createdAt: bound.agent.createdAt,
    updatedAt: bound.binding.updatedAt,
  };
}

export function toVersionView(version: AgentVersion): AgentVersionView {
  return {
    agentVersionId: version.agentVersionId,
    agentId: version.agentId,
    versionNumber: version.versionNumber,
    toolDefaultPolicy: version.toolDefaultPolicy,
    note: version.note,
    createdBy: version.createdBy,
    createdAt: version.createdAt,
    configuration: toSnapshotView(version.snapshot),
    isCurrent: false,
    isCanary: false,
  };
}

export function toHistoryView(entry: VersionInHistory): AgentVersionView {
  return { ...toVersionView(entry.version), isCurrent: entry.isCurrent, isCanary: entry.isCanary };
}

export function toSkillView(assignment: SkillAssignment): AgentSkillView {
  return {
    environmentSkillId: assignment.environmentSkillId,
    enabled: assignment.enabled,
    config: assignment.config,
  };
}

export function toMacroView(visible: VisibleMacro): MacroView {
  return {
    macroId: visible.macro.macroId,
    environmentId: visible.macro.environmentId,
    name: visible.macro.name,
    description: visible.macro.description,
    steps: visible.macro.steps,
    paramSchema: visible.macro.paramSchema,
    sharedWithOrganization: visible.macro.sharedWithOrganization,
    access: visible.access,
    createdBy: visible.macro.createdBy,
    createdAt: visible.macro.createdAt,
    updatedAt: visible.macro.updatedAt,
  };
}

export function toTemplateView(template: PostmanTemplate): PostmanTemplateView {
  return {
    templateId: template.templateId,
    environmentId: template.environmentId,
    agentId: template.agentId,
    name: template.name,
    simulateUserId: template.simulateUserId,
    sessionContext: template.sessionContext,
    isDefault: template.isDefault,
    createdBy: template.createdBy,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}
