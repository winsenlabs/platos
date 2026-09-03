// The published surface of the `agents` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. The two contexts the
// §1 DAG permits to reach it are `governance` and `conversations`, plus, through
// the composition root, `apps/core-api`.
//
// The driven ports are NOT re-exported here. `AgentsRepository`,
// `ScaffoldingRepository`, `AgentVersionLock` and `MacroRecorder` are
// adapter-facing, not context-facing, and are published from
// `application/ports/index.js` where their adapters import them (ADR M0.3 §13).
//
// WHAT THIS SURFACE DELIBERATELY WITHHOLDS.
//
//   * NO `__runtime` ENVELOPE. `AgentVersion.memoryConfig` carries state under a
//     reserved key. `AgentConfigurationView.memoryConfig` is the operator's own
//     configuration with that key removed, because the moment one surface
//     renders the envelope another one saves it back.
//
//   * NO TOOL POLICY, AND NOT BECAUSE IT DOES NOT EXIST. `AgentToolPolicy` hangs
//     off an `AgentVersion` and `tools` is its sole writer (§1 row 7). Every
//     write here that mints a version therefore publishes
//     `previousVersionId` and `versionId` so `tools` can carry its own rows
//     across the same seam. That hand-off is the contract; copying the rows
//     would be a sole-writer violation.
//
//   * NO THREAD COUNT. The running system's agent listing carries one, read
//     from `Thread` — a table `conversations` owns (§1 row 16). A count of
//     another context's rows on this context's read model is a join no boundary
//     rule can see, so it is not here. A surface that needs it asks the context
//     that owns the rows.
//
//   * NO CALLABLE MODEL. `resolveRoute` answers with a model string, a provider
//     and the key that pays for it. Turning that into a session is
//     `providers.openModelRoute`, and running a turn with it is
//     `conversations`'. This context authors agents; it does not execute them.
//
// ONE VIEW IS THIN AND SAYS SO. `AgentSkillView` carries an
// `environmentSkillId` and no skill name, because describing a skill needs the
// `skills` contract and that context was still a generated placeholder when this
// one was made real. `dependencies.ts` records the same fact from the other
// side.

import type { Result } from "@platos/kernel";

import type {
  MacroStep,
  ModelRoute,
  ProviderKeyPin,
  PrunePlan,
  UnbindOutcome,
  VersionChoice,
} from "../domain/index.js";

// The identifier and scope vocabulary a caller needs to build a command. Branded
// types, so an `AgentVersionId` cannot reach an `AgentId` parameter across the
// boundary any more than it can inside it.
export type {
  ActorId,
  AgentBindingId,
  AgentClusterId,
  AgentId,
  AgentSkillId,
  AgentVersionId,
  EnvironmentSkillId,
  MacroId,
  PostmanTemplateId,
  ProviderKeyId,
  RouteLabel,
  Slug,
} from "../domain/index.js";

// The vocabulary a caller reads answers with.
export type {
  DynamicBlockTemplate,
  JsonObject,
  MacroAccess,
  MacroStep,
  ProviderKeyPin,
  PromptBlock,
  PrunePlan,
  SubAgentConfig,
  ToolCallMode,
  ToolDefaultPolicy,
  ToolDisplayMode,
  ToolExposure,
  ToolsBlockConfig,
  UnbindOutcome,
  VersionBucket,
  VersionChoice,
} from "../domain/index.js";

export {
  AGENTS_ERROR_CODES,
  COMPACTION_ROUTE_LABEL,
  DEFAULT_COMPACTION_MODEL,
  DEFAULT_PROVIDER,
  MAX_CANARY_PERCENT,
  MIN_CANARY_PERCENT,
  TOOL_CALL_MODES,
  TOOL_DEFAULT_POLICIES,
  TOOL_DISPLAY_MODES,
  TOOL_EXPOSURES,
} from "../domain/index.js";

// Policy, published so the composition root can override a ceiling without
// reaching into this package for the shape of one.
export type {
  AgentDefaultsPolicy,
  AgentMacroPolicy,
  AgentsPolicy,
  AgentVersionPolicy,
} from "../domain/index.js";
export { COLUMN_CONTEXT_LIMIT, DEFAULT_AGENTS_POLICY } from "../domain/index.js";

// The read models. Split into `contracts/views.ts` so this file stays inside
// the ADR M0.3 §6 budget, and re-exported from here so the published surface is
// still ONE entrypoint: `contracts/index.js`. A caller never imports the split.
export * from "./views.js";

import type {
  AgentClusterView,
  AgentPageView,
  AgentSavedView,
  AgentSkillView,
  AgentVersionPageView,
  AgentVersionView,
  AgentView,
  LoadoutChangedView,
  MacroView,
  PostmanTemplatePageView,
  PostmanTemplateView,
  ResolvedRouteView,
} from "./views.js";

import type { AgentsDependencies } from "../application/index.js";
import * as useCases from "../application/index.js";

// --- commands and queries ----------------------------------------------------

export type {
  AgentConfigurationIntake,
  AppendRecordingCommand,
  ChangeLoadoutCommand,
  ClusterMembershipCommand,
  CreateAgentCommand,
  CreateClusterCommand,
  CreateTemplateCommand,
  DescribeAgentBySlugQuery,
  DescribeAgentQuery,
  DescribeClusterQuery,
  DescribeMacroQuery,
  DescribePinsQuery,
  DescribeTemplateQuery,
  DescribeVersionQuery,
  ListMacrosQuery,
  PageAgentsQuery,
  PageTemplatesQuery,
  PageVersionsQuery,
  PromoteCanaryCommand,
  PruneVersionsQuery,
  ReadAgentsQuery,
  ReadLoadoutQuery,
  RemoveAgentCommand,
  ResolveMacroQuery,
  ResolveRouteQuery,
  RollbackCommand,
  RouteIntake,
  SelectVersionQuery,
  SetCanaryCommand,
  StartRecordingCommand,
  StopRecordingCommand,
  UpdateAgentCommand,
  UpdateClusterCommand,
  UpdateMacroCommand,
  UpdateTemplateCommand,
} from "../application/index.js";

export type { AgentsDependencies } from "../application/index.js";

/**
 * The `agents` capability, as every other context sees it.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no store exception crosses this boundary.
 */
export interface AgentsContract {
  readonly name: "agents";

  // ---- definitions -------------------------------------------------------
  listAgents(query: useCases.ReadAgentsQuery): Promise<Result<readonly AgentView[]>>;
  pageAgents(query: useCases.PageAgentsQuery): Promise<Result<AgentPageView>>;
  describeAgent(query: useCases.DescribeAgentQuery): Promise<Result<AgentView>>;
  describeAgentBySlug(query: useCases.DescribeAgentBySlugQuery): Promise<Result<AgentView>>;
  createAgent(command: useCases.CreateAgentCommand): Promise<Result<AgentView>>;
  /** Reports separately what moved: the row, the cluster, the configuration. */
  updateAgent(command: useCases.UpdateAgentCommand): Promise<Result<AgentSavedView>>;
  /** Removes the BINDING. The definition survives while another environment binds it. */
  removeAgent(command: useCases.RemoveAgentCommand): Promise<Result<UnbindOutcome>>;

  // ---- versions ----------------------------------------------------------
  pageVersions(query: useCases.PageVersionsQuery): Promise<Result<AgentVersionPageView>>;
  describeVersion(query: useCases.DescribeVersionQuery): Promise<Result<AgentVersionView>>;
  /** Writes the old snapshot FORWARD as a new version. History stays append-only. */
  rollbackToVersion(command: useCases.RollbackCommand): Promise<Result<AgentView>>;
  /** A retention PLAN. Nothing is deleted; see `domain/version.ts`. */
  planVersionPrune(query: useCases.PruneVersionsQuery): Promise<Result<PrunePlan>>;

  // ---- canary ------------------------------------------------------------
  setCanary(command: useCases.SetCanaryCommand): Promise<Result<AgentView>>;
  promoteCanary(command: useCases.PromoteCanaryCommand): Promise<Result<AgentView>>;
  /**
   * Which version answers this turn.
   *
   * The one runtime method on this contract, and it takes its randomness as an
   * argument: given a binding, a draw and a thread it is deterministic, which is
   * what makes stickiness and the boundary percentages testable.
   */
  selectVersion(query: useCases.SelectVersionQuery): Promise<Result<VersionChoice>>;

  // ---- clusters ----------------------------------------------------------
  listClusters(query: useCases.ClusterQuery): Promise<Result<readonly AgentClusterView[]>>;
  describeCluster(query: useCases.DescribeClusterQuery): Promise<Result<AgentClusterView>>;
  createCluster(command: useCases.CreateClusterCommand): Promise<Result<AgentClusterView>>;
  updateCluster(command: useCases.UpdateClusterCommand): Promise<Result<AgentClusterView>>;
  removeCluster(query: useCases.DescribeClusterQuery): Promise<Result<boolean>>;
  addAgentToCluster(command: useCases.ClusterMembershipCommand): Promise<Result<AgentClusterView>>;
  removeAgentFromCluster(command: useCases.ClusterMembershipCommand): Promise<Result<AgentClusterView>>;

  // ---- skill loadout -----------------------------------------------------
  readLoadout(query: useCases.ReadLoadoutQuery): Promise<Result<readonly AgentSkillView[]>>;
  /** Every loadout change mints a version. `application/loadout.ts` says why. */
  enableSkill(command: useCases.ChangeLoadoutCommand): Promise<Result<LoadoutChangedView>>;
  disableSkill(command: useCases.ChangeLoadoutCommand): Promise<Result<LoadoutChangedView>>;
  removeSkill(command: useCases.ChangeLoadoutCommand): Promise<Result<LoadoutChangedView>>;

  // ---- saved-request scaffolding -----------------------------------------
  listMacros(query: useCases.ListMacrosQuery): Promise<Result<readonly MacroView[]>>;
  describeMacro(query: useCases.DescribeMacroQuery): Promise<Result<MacroView>>;
  updateMacro(command: useCases.UpdateMacroCommand): Promise<Result<MacroView>>;
  removeMacro(query: useCases.DescribeMacroQuery): Promise<Result<boolean>>;
  /** The steps a replay would dispatch. This context substitutes; it never calls. */
  resolveMacro(query: useCases.ResolveMacroQuery): Promise<Result<readonly MacroStep[]>>;
  startRecording(command: useCases.StartRecordingCommand): Promise<Result<{ readonly recordingId: string }>>;
  appendRecordingStep(command: useCases.AppendRecordingCommand): Promise<Result<void>>;
  stopRecording(command: useCases.StopRecordingCommand): Promise<Result<MacroView>>;

  pageTemplates(query: useCases.PageTemplatesQuery): Promise<Result<PostmanTemplatePageView>>;
  describeTemplate(query: useCases.DescribeTemplateQuery): Promise<Result<PostmanTemplateView>>;
  createTemplate(command: useCases.CreateTemplateCommand): Promise<Result<PostmanTemplateView>>;
  updateTemplate(command: useCases.UpdateTemplateCommand): Promise<Result<PostmanTemplateView>>;
  removeTemplate(query: useCases.DescribeTemplateQuery): Promise<Result<boolean>>;

  // ---- routing -----------------------------------------------------------
  /** Model + key. Opening the route is `providers`'; running the turn is not ours. */
  resolveRoute(query: useCases.ResolveRouteQuery): Promise<Result<ResolvedRouteView>>;
  resolveCompactionRoute(query: useCases.DescribePinsQuery): Promise<Result<ResolvedRouteView>>;
  /** Which provider keys the live version pins. The read side of the delete guard. */
  describePins(query: useCases.DescribePinsQuery): Promise<Result<readonly ProviderKeyPin[]>>;
}

/** The integration events this context publishes through the kernel outbox. */
export const AGENTS_EVENT_NAMES = [
  "agents.agent.created",
  "agents.agent.updated",
  "agents.agent.unbound",
  "agents.version.minted",
  "agents.version.rolled_back",
  "agents.canary.set",
  "agents.canary.promoted",
  "agents.cluster.created",
  "agents.cluster.updated",
  "agents.cluster.removed",
  "agents.loadout.changed",
  "agents.macro.recorded",
  "agents.macro.shared",
] as const;

export type AgentsEventName = (typeof AGENTS_EVENT_NAMES)[number];

/**
 * Retained from the generated skeleton so no sibling placeholder breaks. The
 * "aggregate" this context hands out is an agent as one environment sees it, not
 * a row.
 */
export type AgentsAggregate = AgentView;

function clusterView(described: {
  readonly cluster: useCases.ClusterWithMembers["cluster"];
  readonly members: useCases.ClusterWithMembers["members"];
}): AgentClusterView {
  return {
    clusterId: described.cluster.clusterId,
    environmentId: described.cluster.environmentId,
    name: described.cluster.name,
    slug: described.cluster.slug,
    description: described.cluster.description,
    primaryAgentId: primaryOf(described.cluster),
    members: [...described.members],
    createdAt: described.cluster.createdAt,
    updatedAt: described.cluster.updatedAt,
  };
}

function primaryOf(cluster: useCases.ClusterWithMembers["cluster"]): string | null {
  const value = cluster.metadata?.["primaryAgentId"];
  return typeof value === "string" && value !== "" ? value : null;
}

function routeView(resolved: useCases.ResolvedRoute): ResolvedRouteView {
  return {
    label: resolved.label,
    model: resolved.model,
    provider: resolved.provider,
    providerKeyId: resolved.providerKeyId,
    credentialName: resolved.credentialName,
  };
}

/**
 * Bind the use cases into the driving port.
 *
 * The composition root builds the dependency bundle from adapters and calls this
 * once. Nothing here holds state: it is a lookup table from a contract method to
 * the one use case that implements it, which is what keeps the contract from
 * quietly growing behaviour of its own.
 */
export function agentsContract(dependencies: AgentsDependencies): AgentsContract {
  const map = <Value, View>(result: Result<Value>, view: (value: Value) => View): Result<View> =>
    result.ok ? { ok: true, value: view(result.value) } : result;

  const minted = (written: useCases.LoadoutChanged): LoadoutChangedView => ({
    agent: useCases.toAgentView(written.bound),
    previousVersionId: written.previousVersionId,
    versionId: written.bound.activeVersion.agentVersionId,
    loadout: written.loadout.map(useCases.toSkillView),
  });

  const contract: AgentsContract = {
    name: "agents",

    listAgents: async (query) =>
      map(await useCases.listAgents(dependencies, query), (bound) => bound.map(useCases.toAgentView)),
    pageAgents: async (query) =>
      map(await useCases.pageAgents(dependencies, query), (page) => ({
        items: page.items.map(useCases.toAgentView),
        total: page.total,
      })),
    describeAgent: async (query) =>
      map(await useCases.describeAgent(dependencies, query), useCases.toAgentView),
    describeAgentBySlug: async (query) =>
      map(await useCases.describeAgentBySlug(dependencies, query), useCases.toAgentView),
    createAgent: async (command) =>
      map(await useCases.createAgent(dependencies, command), useCases.toAgentView),
    updateAgent: async (command) =>
      map(await useCases.updateAgent(dependencies, command), (saved) => ({
        agent: useCases.toAgentView(saved.bound),
        renamed: saved.renamed,
        reclustered: saved.reclustered,
        previousVersionId: saved.previousVersionId,
      })),
    removeAgent: (command) => useCases.removeAgent(dependencies, command),

    pageVersions: async (query) =>
      map(await useCases.pageVersions(dependencies, query), (page) => ({
        items: page.items.map(useCases.toHistoryView),
        total: page.total,
        nextCursor: page.nextCursor,
        offset: page.offset,
        limit: page.limit,
      })),
    describeVersion: async (query) =>
      map(await useCases.describeVersion(dependencies, query), useCases.toHistoryView),
    rollbackToVersion: async (command) =>
      map(await useCases.rollbackToVersion(dependencies, command), useCases.toAgentView),
    planVersionPrune: (query) => useCases.planVersionPrune(dependencies, query),

    setCanary: async (command) =>
      map(await useCases.setCanary(dependencies, command), useCases.toAgentView),
    promoteCanary: async (command) =>
      map(await useCases.promoteCanary(dependencies, command), useCases.toAgentView),
    selectVersion: (query) => useCases.selectVersion(dependencies, query),

    listClusters: async (query) =>
      map(await useCases.listClusters(dependencies, query), (clusters) =>
        clusters.map((cluster) => clusterView({ cluster, members: [] })),
      ),
    describeCluster: async (query) =>
      map(await useCases.describeCluster(dependencies, query), clusterView),
    createCluster: async (command) =>
      map(await useCases.createCluster(dependencies, command), clusterView),
    updateCluster: async (command) =>
      map(await useCases.updateCluster(dependencies, command), clusterView),
    removeCluster: (query) => useCases.removeCluster(dependencies, query),
    addAgentToCluster: async (command) =>
      map(await useCases.addAgentToCluster(dependencies, command), clusterView),
    removeAgentFromCluster: async (command) =>
      map(await useCases.removeAgentFromCluster(dependencies, command), clusterView),

    readLoadout: async (query) =>
      map(await useCases.readLoadout(dependencies, query), (loadout) =>
        loadout.map(useCases.toSkillView),
      ),
    enableSkill: async (command) => map(await useCases.enableSkill(dependencies, command), minted),
    disableSkill: async (command) => map(await useCases.disableSkill(dependencies, command), minted),
    removeSkill: async (command) => map(await useCases.removeSkill(dependencies, command), minted),

    listMacros: async (query) =>
      map(await useCases.listMacros(dependencies, query), (macros) => macros.map(useCases.toMacroView)),
    describeMacro: async (query) =>
      map(await useCases.describeMacro(dependencies, query), useCases.toMacroView),
    updateMacro: async (command) =>
      map(await useCases.updateMacro(dependencies, command), (macro) =>
        useCases.toMacroView({ macro, access: "owner" }),
      ),
    removeMacro: (query) => useCases.removeMacro(dependencies, query),
    resolveMacro: (query) => useCases.resolveMacro(dependencies, query),
    startRecording: async (command) =>
      map(await useCases.startRecording(dependencies, command), (recording) => ({
        recordingId: recording.recordingId,
      })),
    appendRecordingStep: (command) => useCases.appendRecordingStep(dependencies, command),
    stopRecording: async (command) =>
      map(await useCases.stopRecording(dependencies, command), (macro) =>
        useCases.toMacroView({ macro, access: "owner" }),
      ),

    pageTemplates: async (query) =>
      map(await useCases.pageTemplates(dependencies, query), (page) => ({
        items: page.items.map(useCases.toTemplateView),
        total: page.total,
      })),
    describeTemplate: async (query) =>
      map(await useCases.describeTemplate(dependencies, query), useCases.toTemplateView),
    createTemplate: async (command) =>
      map(await useCases.createTemplate(dependencies, command), useCases.toTemplateView),
    updateTemplate: async (command) =>
      map(await useCases.updateTemplate(dependencies, command), useCases.toTemplateView),
    removeTemplate: (query) => useCases.removeTemplate(dependencies, query),

    resolveRoute: async (query) => map(await useCases.resolveRoute(dependencies, query), routeView),
    resolveCompactionRoute: async (query) =>
      map(await useCases.resolveCompactionRoute(dependencies, query), routeView),
    describePins: (query) => useCases.describePins(dependencies, query),
  };
  return Object.freeze(contract);
}

export type { ModelRoute };
