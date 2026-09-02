// The published surface of the `tools` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. The one context the
// §1 DAG permits to reach it is `conversations`, plus `apps/core-api` and
// `apps/mcp-stdio` through the composition root.
//
// The driven `ToolDispatch`, `ToolsRepository` and `ContentDigest` ports are
// NOT re-exported here. They are adapter-facing, not context-facing, and they
// are published from `application/ports/index.js` where their adapters import
// them (ADR M0.3 §13).
//
// WHAT THIS SURFACE DELIBERATELY WITHHOLDS.
//
//   * NO CALLBACK URL, ANYWHERE. It is the address of a customer's backend and
//     often carries a path segment that is effectively a shared secret. A
//     caller asking "can this be called" reads `dispatchable`.
//
//   * NO RESOLVED HEADERS AND NO WAY TO ASK FOR ANY. There is no method that
//     returns a substituted header set and no field that could hold one. The
//     resolved values exist between `resolve-transport.ts` and the adapter that
//     spends them, and nowhere else.
//
//   * NO CREDENTIAL ID. `EntityMcpClient` names its credential and the view
//     does not identify it. An id is a handle into `secrets`' store.
//
//   * NO AUDIT ARGUMENTS OR RESULTS ON THE LISTING. Both are sealed at rest and
//     both carry the user's own words; opening them is a separate, deliberate
//     act by a surface that has decided who is looking.
//
// WHAT IT DELIBERATELY EXPOSES. `resolvePermission` is published even though
// `executeTool` already applies it. A caller that must show a human what will
// happen — an approval queue, a dry-run, an operator console — needs the
// decision without the side effect, and the alternative is that caller
// reimplementing the four-tier lattice from the enum.

import type { EnvironmentScope, EntityId, Result } from "@platos/kernel";

import type { McpCaller } from "../domain/index.js";

// The identifier and vocabulary a caller needs to build a command. Branded
// types, so a `toolId` cannot reach an `exposureId` parameter across the
// boundary any more than it can inside it.
export type {
  AgentId,
  EndUserId,
  ExposureId,
  ExternalEntityId,
  ThreadId,
  ToolCallAuditId,
  ToolId,
  ToolName,
} from "../domain/index.js";

// The vocabulary a caller reads answers with.
export type {
  CallStatus,
  ConnectionKind,
  DisambiguationStrategy,
  DispatchSource,
  HealthOutcome,
  IdentityMode,
  McpCaller,
  McpTransport,
  PermissionState,
  PermissionTier,
  PolicyEffect,
  TokenTier,
  ToolKind,
} from "../domain/index.js";

export {
  CALL_STATUSES,
  CONNECTION_KINDS,
  DISAMBIGUATION_STRATEGIES,
  DISPATCH_SOURCES,
  HEALTH_OUTCOMES,
  IDENTITY_MODES,
  MCP_TRANSPORTS,
  PERMISSION_STATES,
  POLICY_EFFECTS,
  TOKEN_TIERS,
  TOOLS_ERROR_CODES,
  TOOL_KINDS,
} from "../domain/index.js";

// The four-tier baseline, published as data so an operator console can render
// what the installation refuses without asking about a tool it has not called.
export type { PlatformMinimum } from "../domain/index.js";
export { PLATFORM_TIER_MINIMUMS, isMutatingToolName } from "../domain/index.js";

// Policy, published so the composition root can override a budget without
// reaching into this package for the shape of one.
export type {
  ToolAclPolicy,
  ToolDiscoveryPolicy,
  ToolDispatchPolicy,
  ToolsPolicy,
} from "../domain/index.js";
export { DEFAULT_TOOLS_POLICY } from "../domain/index.js";

import type { ToolsDependencies } from "../application/index.js";
import * as useCases from "../application/index.js";

// --- read models -------------------------------------------------------------

export type {
  McpSurfaceView,
  PermissionView,
  ToolAuditView,
  ToolHealthView,
  ToolPolicyView,
  ToolView,
} from "../application/index.js";

export interface ToolPageView {
  readonly items: readonly useCases.ToolView[];
  readonly total: number;
}

// --- commands and queries ----------------------------------------------------

export type {
  ConfigureMcpSurfaceCommand,
  DeleteOrganizationPolicyCommand,
  DiscoverEntityToolsCommand,
  DiscoveryReport,
  DescribeMcpSurfaceQuery,
  ExecuteToolCommand,
  ExecutedTool,
  FindToolsQuery,
  PageToolsQuery,
  ReadEntityToolPoliciesQuery,
  ReadOrganizationPoliciesQuery,
  ReadToolAuditQuery,
  ReadToolsQuery,
  RegisterToolsCommand,
  ResolvePermissionQuery,
  SetEntityToolPolicyCommand,
  SetOrganizationPolicyCommand,
  SetToolEnabledCommand,
  ToolsDependencies,
} from "../application/index.js";

export interface RegisteredToolsView {
  readonly registered: number;
  readonly updated: number;
  readonly newTools: number;
  readonly removed: number;
  readonly tools: readonly useCases.ToolView[];
}

export interface OrganizationPolicyView {
  readonly organizationMcpPolicyId: string;
  readonly pattern: string;
  /**
   * `auto_allow` or `block`. NEVER `require_approval`: the column is
   * two-valued. A caller asking for the third is refused by
   * `setOrganizationPolicy` rather than rounded to the nearest.
   */
  readonly state: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The `tools` capability, as every other context sees it.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no vendor exception crosses this boundary.
 */
export interface ToolsContract {
  readonly name: "tools";

  // ---- the registry (operator grant) --------------------------------------
  /** Replace one entity's complete declaration for this environment. */
  registerTools(command: useCases.RegisterToolsCommand): Promise<Result<RegisteredToolsView>>;
  listTools(query: useCases.ReadToolsQuery): Promise<Result<readonly useCases.ToolView[]>>;
  pageTools(query: useCases.PageToolsQuery): Promise<Result<ToolPageView>>;
  setToolEnabled(command: useCases.SetToolEnabledCommand): Promise<Result<useCases.ToolView>>;

  // ---- discovery ----------------------------------------------------------
  /**
   * Rank the callable tools against a natural-language query.
   *
   * The seam a turn reaches for. It does not run a turn: composing one out of
   * tool results belongs to `conversations`, which the ADR extracts last.
   */
  findTools(query: useCases.FindToolsQuery): Promise<Result<readonly useCases.ToolView[]>>;
  /** Ask an MCP entity what it offers, and register the answer. */
  discoverEntityTools(
    command: useCases.DiscoverEntityToolsCommand,
  ): Promise<Result<useCases.DiscoveryReport>>;

  // ---- execution ----------------------------------------------------------
  /** The four-tier decision, without the side effect. */
  resolvePermission(query: useCases.ResolvePermissionQuery): Promise<Result<useCases.PermissionView>>;
  executeTool(command: useCases.ExecuteToolCommand): Promise<Result<useCases.ExecutedTool>>;

  // ---- the inbound MCP surface --------------------------------------------
  describeMcpSurface(query: useCases.DescribeMcpSurfaceQuery): Promise<Result<useCases.McpSurfaceView>>;
  configureMcpSurface(
    command: useCases.ConfigureMcpSurfaceCommand,
  ): Promise<Result<useCases.McpSurfaceView>>;
  listEntityToolPolicies(
    query: useCases.ReadEntityToolPoliciesQuery,
  ): Promise<Result<readonly useCases.ToolPolicyView[]>>;
  setEntityToolPolicy(
    command: useCases.SetEntityToolPolicyCommand,
  ): Promise<Result<useCases.ToolPolicyView>>;
  /** What one authenticated inbound caller may see — the `tools/list` answer. */
  listCallableForMcpCaller(
    scope: EnvironmentScope,
    entityId: EntityId,
    caller: McpCaller,
  ): Promise<Result<readonly useCases.ToolView[]>>;

  // ---- tier-2 policy ------------------------------------------------------
  listOrganizationPolicies(
    query: useCases.ReadOrganizationPoliciesQuery,
  ): Promise<Result<readonly OrganizationPolicyView[]>>;
  setOrganizationPolicy(
    command: useCases.SetOrganizationPolicyCommand,
  ): Promise<Result<OrganizationPolicyView>>;
  deleteOrganizationPolicy(
    command: useCases.DeleteOrganizationPolicyCommand,
  ): Promise<Result<boolean>>;

  // ---- the audit trail ----------------------------------------------------
  readToolAudit(query: useCases.ReadToolAuditQuery): Promise<Result<readonly useCases.ToolAuditView[]>>;
}

/** The integration events this context publishes through the kernel outbox. */
export const TOOLS_EVENT_NAMES = [
  "tools.tools.registered",
  "tools.tool.enabled",
  "tools.tool.disabled",
  "tools.call.dispatched",
  "tools.call.refused",
  "tools.call.awaiting_approval",
  "tools.entity_policy.changed",
  "tools.organization_policy.changed",
  "tools.mcp_surface.enabled",
  "tools.mcp_surface.disabled",
  "tools.discovery.completed",
] as const;

export type ToolsEventName = (typeof TOOLS_EVENT_NAMES)[number];

/**
 * Retained from the generated skeleton so no sibling placeholder breaks. The
 * "aggregate" this context hands out is a tool's resolved exposure, not a row.
 */
export type ToolsAggregate = useCases.ToolView;

/**
 * Bind the use cases into the driving port.
 *
 * The composition root builds the dependency bundle from adapters and calls
 * this once. Nothing here holds state: it is a lookup table from a contract
 * method to the one use case that implements it, which is what keeps the
 * contract from quietly growing behaviour of its own.
 */
export function toolsContract(dependencies: ToolsDependencies): ToolsContract {
  const map = <Value, View>(result: Result<Value>, view: (value: Value) => View): Result<View> =>
    result.ok ? { ok: true, value: view(result.value) } : result;

  const contract: ToolsContract = {
    name: "tools",

    registerTools: async (command) =>
      map(await useCases.registerTools(dependencies, command), (registered) => ({
        ...registered.outcome,
        tools: registered.exposures.map(useCases.toToolView),
      })),
    listTools: async (query) =>
      map(await useCases.listTools(dependencies, query), (tools) => tools.map(useCases.toToolView)),
    pageTools: async (query) =>
      map(await useCases.pageTools(dependencies, query), (page) => ({
        items: page.items.map(useCases.toToolView),
        total: page.total,
      })),
    setToolEnabled: async (command) =>
      map(await useCases.setToolEnabled(dependencies, command), useCases.toToolView),

    findTools: async (query) =>
      map(await useCases.findTools(dependencies, query), (tools) => tools.map(useCases.toToolView)),
    discoverEntityTools: (command) => useCases.discoverEntityTools(dependencies, command),

    resolvePermission: async (query) =>
      map(await useCases.resolvePermission(dependencies, query), useCases.toPermissionView),
    executeTool: (command) => useCases.executeTool(dependencies, command),

    describeMcpSurface: async (query) =>
      map(await useCases.describeMcpSurface(dependencies, query), (state) =>
        useCases.toMcpSurfaceView(state.config, state.ready),
      ),
    configureMcpSurface: async (command) =>
      map(await useCases.configureMcpSurface(dependencies, command), (state) =>
        useCases.toMcpSurfaceView(state.config, state.ready),
      ),
    listEntityToolPolicies: async (query) =>
      map(await useCases.listEntityToolPolicies(dependencies, query), (policies) =>
        policies.map(useCases.toToolPolicyView),
      ),
    setEntityToolPolicy: async (command) =>
      map(await useCases.setEntityToolPolicy(dependencies, command), useCases.toToolPolicyView),
    listCallableForMcpCaller: async (scope, entityId, caller) =>
      map(
        await useCases.listCallableForMcpCaller(dependencies, scope, entityId, caller),
        (tools) => tools.map(useCases.toToolView),
      ),

    listOrganizationPolicies: async (query) =>
      map(await useCases.listOrganizationPolicies(dependencies, query), (policies) =>
        policies.map(toOrganizationPolicyView),
      ),
    setOrganizationPolicy: async (command) =>
      map(await useCases.setOrganizationPolicy(dependencies, command), toOrganizationPolicyView),
    deleteOrganizationPolicy: (command) => useCases.deleteOrganizationPolicy(dependencies, command),

    readToolAudit: async (query) =>
      map(await useCases.readToolAudit(dependencies, query), (entries) =>
        entries.map(useCases.toToolAuditView),
      ),
  };
  return Object.freeze(contract);
}

function toOrganizationPolicyView(record: useCases.OrganizationPolicyRecord): OrganizationPolicyView {
  return {
    organizationMcpPolicyId: record.organizationMcpPolicyId,
    pattern: record.pattern,
    state: record.effect === "DENY" ? "block" : "auto_allow",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
