// The `agents` read models.
//
// Split out of `contracts/index.ts` so that file stays inside the ADR M0.3 §6
// budget, and re-exported from it so the published surface is still ONE
// entrypoint. A caller imports `contracts/index.js` and never names this file.
//
// A VIEW IS WHERE THE ENVELOPE STOPS. `AgentConfigurationView` is the version
// snapshot minus `memoryConfig.__runtime`, because the moment one surface
// renders the carried state another one saves it back — see
// `domain/version-envelope.ts`. It is otherwise TOTAL: a field missing here is a
// field a rollback silently drops, and the diff an operator reads to see what
// changed is a diff of exactly this shape.

import type { EnvironmentId, ProjectId } from "@platos/kernel";

import type {
  DynamicBlockTemplate,
  JsonObject,
  MacroAccess,
  MacroStep,
  PromptBlock,
  SubAgentConfig,
  ToolDefaultPolicy,
  ToolsBlockConfig,
} from "../domain/index.js";

/** One model route, as seen from outside. Same shape; no stored alias. */
export interface ModelRouteView {
  readonly label: string;
  readonly model: string;
  readonly providerKeyId: string | null;
  readonly isDefault: boolean;
}

/**
 * Every user-editable field of an agent, at one instant.
 *
 * This IS the version snapshot, minus the carried envelope. A rollback restores
 * exactly these fields, and a diff between two of them is what an operator reads
 * to see what changed — so a field missing here is a field a rollback silently
 * drops.
 */
export interface AgentConfigurationView {
  readonly model: string;
  readonly modelRoutes: readonly ModelRouteView[] | null;
  readonly systemPrompt: string | null;
  readonly promptBlocks: readonly PromptBlock[] | null;
  readonly dynamicBlocks: readonly DynamicBlockTemplate[] | null;
  readonly maxSteps: number;
  readonly contextLimit: number;
  readonly historyMode: string;
  readonly compactThreshold: number;
  readonly enableUserProfiling: boolean;
  readonly toolMode: string;
  readonly executionMode: string;
  readonly toolsBlockConfig: ToolsBlockConfig | null;
  readonly subAgentConfig: SubAgentConfig | null;
  /** The operator's own memory configuration. The envelope is not here. */
  readonly memoryConfig: JsonObject | null;
  readonly metaTools: Readonly<Record<string, boolean>> | null;
  readonly featureFlags: Readonly<Record<string, boolean>> | null;
  readonly outputSchema: JsonObject | null;
  readonly extractionPolicy: JsonObject | null;
  readonly enableThreading: boolean;
  readonly threadingConfig: JsonObject | null;
  readonly contextMapping: JsonObject | null;
  readonly providerKeyId: string | null;
  readonly visibility: string | null;
  readonly maxJobsPerTurn: number | null;
  readonly agentRetryConfig: JsonObject | null;
}

/**
 * An agent as it exists in ONE environment.
 *
 * `projectId` and `environmentId` are both here because the agent is
 * project-scoped and its binding is not: the same agent id read from another
 * environment is a different view, and a caller holding one should be able to
 * tell which.
 */
export interface AgentView {
  readonly agentId: string;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly clusterId: string | null;
  readonly currentVersionId: string;
  readonly currentVersionNumber: number;
  readonly canaryVersionId: string | null;
  /** Null when nothing is in canary, or when the canary row could not load. */
  readonly canaryVersionNumber: number | null;
  readonly canaryPercent: number;
  readonly configuration: AgentConfigurationView;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentPageView {
  readonly items: readonly AgentView[];
  readonly total: number;
  /**
   * The window that was APPLIED, after `AgentsPolicy.maxPageSize` clamped it.
   *
   * Published rather than kept inside, for the reason `AgentVersionPageView`
   * below publishes the same pair: a caller that asked for ten thousand rows and
   * got two hundred needs to be told, and a clamp invisible on the answer is a
   * clamp nothing can prove.
   */
  readonly offset: number;
  readonly limit: number;
}

export interface AgentVersionView {
  readonly agentVersionId: string;
  readonly agentId: string;
  readonly versionNumber: number;
  readonly toolDefaultPolicy: ToolDefaultPolicy;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly configuration: AgentConfigurationView;
  readonly isCurrent: boolean;
  readonly isCanary: boolean;
}

export interface AgentVersionPageView {
  readonly items: readonly AgentVersionView[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly offset: number;
  readonly limit: number;
}

/** One entry of a version's loadout. Thin by construction — see the note above. */
export interface AgentSkillView {
  readonly environmentSkillId: string;
  readonly enabled: boolean;
  readonly config: JsonObject;
}

export interface AgentClusterView {
  readonly clusterId: string;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly primaryAgentId: string | null;
  readonly members: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MacroView {
  readonly macroId: string;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly description: string | null;
  readonly steps: readonly MacroStep[];
  readonly paramSchema: JsonObject | null;
  readonly sharedWithOrganization: boolean;
  /** On what basis this caller may see it: its own, or shared into its scope. */
  readonly access: MacroAccess;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PostmanTemplateView {
  readonly templateId: string;
  readonly environmentId: EnvironmentId;
  readonly agentId: string;
  readonly name: string;
  readonly simulateUserId: string;
  readonly sessionContext: JsonObject | null;
  readonly isDefault: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PostmanTemplatePageView {
  readonly items: readonly PostmanTemplateView[];
  readonly total: number;
  /** The window that was APPLIED. See `AgentPageView`. */
  readonly offset: number;
  readonly limit: number;
}

/**
 * A write that minted a version, and the hand-off `tools` needs.
 *
 * Both ids travel because `AgentToolPolicy` belongs to a version and to `tools`:
 * the previous id is the source of the rows to carry, the new one is the
 * destination. See the note at the top of this file.
 */
export interface VersionMintedView {
  readonly agent: AgentView;
  readonly previousVersionId: string;
  readonly versionId: string;
}

export interface AgentSavedView {
  readonly agent: AgentView;
  readonly renamed: boolean;
  readonly reclustered: boolean;
  /** Null when the configuration did not change and no version was minted. */
  readonly previousVersionId: string | null;
}

export interface LoadoutChangedView extends VersionMintedView {
  readonly loadout: readonly AgentSkillView[];
}

/** Which model answers, and which key pays for it. */
export interface ResolvedRouteView {
  readonly label: string | null;
  readonly model: string;
  readonly provider: string;
  readonly providerKeyId: string | null;
  /** The credential's bare name, when a key is pinned and resolved. */
  readonly credentialName: string | null;
}
