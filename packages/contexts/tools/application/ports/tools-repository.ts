// The canonical-store port behind which this context's sole-writer ownership of
// its ten rows is realised.
//
// ADR M0.3 §1 row 7 names them: Tool, EnvironmentEntityTool, ToolHealth,
// ToolCall, ToolCallAudit, AgentToolPolicy, EntityToolPolicy, EntityMcpConfig,
// EntityMcpClient, OrganizationMcpPolicy. Nothing else in the repository may
// mutate any of them, and `scripts/arch/sole-writer.mjs` is the gate that says
// so. This interface is the only shape those writes take.
//
// EVERY METHOD RETURNS `Result`. A store failure is a business outcome the
// caller must handle, not an exception that unwinds through a use case, and a
// vendor error type must not cross this line.
//
// EVERY SCOPED METHOD TAKES AN `EnvironmentScope`. Not an `environmentId`: the
// scope carries the whole ancestry, so an adapter's `where` clause is built
// from the organization and project as well as the leaf. A repository method
// keyed on the leaf alone would happily read an environment that has since been
// re-parented, which is precisely the cross-tenant read the tenancy tree
// exists to prevent.
//
// TWO METHODS ARE DELIBERATELY NOT SCOPED. `findToolByFingerprint` and
// `upsertTool` address the `Tool` table, which is INSTALLATION-GLOBAL: the row
// is a content-addressed schema version keyed `@@unique([name, schemaHash])`
// with no tenancy column at all. Pretending otherwise would invent a scope the
// store does not have and hide the fact that two organizations declaring an
// identical tool share one row — which is safe precisely because the row holds
// no tenant data, and unsafe to forget.

import type { EnvironmentScope, EntityId, Result } from "@platos/kernel";

import type {
  AgentPolicyBinding,
  AuditEntry,
  AuditQuery,
  EntityMcpClient,
  EntityMcpConfig,
  EntityToolPolicy,
  ExposureId,
  ExternalEntityId,
  PolicyEffect,
  SchemaHash,
  Tool,
  ToolCall,
  ToolExposure,
  ToolHealth,
  ToolId,
  ToolName,
  OrganizationMcpPolicyId,
} from "../../domain/index.js";

/** One page of exposures, and the total the page was drawn from. */
export interface ExposurePage {
  readonly items: readonly ToolExposure[];
  readonly total: number;
}

export interface ExposurePageQuery {
  readonly limit: number;
  readonly offset: number;
  readonly entityId?: EntityId | null;
  readonly search?: string | null;
}

/** What one entity's registration replaces, as a single atomic statement. */
export interface ExposureReplacement {
  readonly scope: EnvironmentScope;
  readonly entityId: EntityId;
  readonly callbackUrl: string | null;
  /** The complete set. Anything absent is deleted, which is the point. */
  readonly toolIds: readonly ToolId[];
}

export interface ToolUpsert {
  readonly name: ToolName;
  readonly description: string;
  readonly paramSchema: Readonly<Record<string, unknown>>;
  readonly category: string;
  readonly schemaHash: SchemaHash;
}

export interface OrganizationPolicyRecord {
  readonly organizationMcpPolicyId: OrganizationMcpPolicyId;
  readonly pattern: string;
  readonly effect: PolicyEffect;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ToolsRepository {
  // ---- Tool: installation-global, content-addressed, never updated --------
  findToolByFingerprint(name: ToolName, schemaHash: SchemaHash): Promise<Result<Tool | null>>;
  /**
   * Find-or-create. NEVER an update: a changed shape is a new row, so a
   * `Tool` an exposure points at cannot change under it.
   */
  upsertTool(tool: ToolUpsert): Promise<Result<Tool>>;
  findTools(toolIds: readonly ToolId[]): Promise<Result<readonly Tool[]>>;

  // ---- EnvironmentEntityTool: the dispatch matrix -------------------------
  /** The whole matrix for a scope, resolved with policies and dispatchability. */
  listExposures(scope: EnvironmentScope): Promise<Result<readonly ToolExposure[]>>;
  listEntityExposures(
    scope: EnvironmentScope,
    entityId: EntityId,
  ): Promise<Result<readonly ToolExposure[]>>;
  pageExposures(scope: EnvironmentScope, query: ExposurePageQuery): Promise<Result<ExposurePage>>;
  /** Replace one entity's complete declaration. One transaction, or none. */
  replaceExposures(replacement: ExposureReplacement): Promise<Result<readonly ToolExposure[]>>;
  setExposureEnabled(
    scope: EnvironmentScope,
    exposureId: ExposureId,
    enabled: boolean,
  ): Promise<Result<ToolExposure>>;

  // ---- AgentToolPolicy: read-only here; `agents` authors the versions -----
  listAgentPolicyBindings(scope: EnvironmentScope): Promise<Result<readonly AgentPolicyBinding[]>>;
  findAgentPolicyBinding(
    scope: EnvironmentScope,
    agentId: string,
  ): Promise<Result<AgentPolicyBinding | null>>;

  // ---- EntityToolPolicy: the inbound-surface exposure decision ------------
  listEntityToolPolicies(
    scope: EnvironmentScope,
    entityId: EntityId,
  ): Promise<Result<readonly EntityToolPolicy[]>>;
  upsertEntityToolPolicy(policy: EntityToolPolicy): Promise<Result<EntityToolPolicy>>;

  // ---- OrganizationMcpPolicy: tier 2 -------------------------------------
  listOrganizationPolicies(scope: EnvironmentScope): Promise<Result<readonly OrganizationPolicyRecord[]>>;
  upsertOrganizationPolicy(
    scope: EnvironmentScope,
    pattern: string,
    effect: PolicyEffect,
  ): Promise<Result<OrganizationPolicyRecord>>;
  deleteOrganizationPolicy(
    scope: EnvironmentScope,
    organizationMcpPolicyId: OrganizationMcpPolicyId,
  ): Promise<Result<boolean>>;

  // ---- EntityMcpConfig / EntityMcpClient ---------------------------------
  findMcpConfig(scope: EnvironmentScope, entityId: EntityId): Promise<Result<EntityMcpConfig | null>>;
  saveMcpConfig(scope: EnvironmentScope, config: EntityMcpConfig): Promise<Result<EntityMcpConfig>>;
  findMcpClient(scope: EnvironmentScope, entityId: EntityId): Promise<Result<EntityMcpClient | null>>;
  saveMcpClient(scope: EnvironmentScope, client: EntityMcpClient): Promise<Result<EntityMcpClient>>;

  // ---- ToolCall: the turn transcript --------------------------------------
  listStepCalls(scope: EnvironmentScope, stepId: string): Promise<Result<readonly ToolCall[]>>;
  saveCall(scope: EnvironmentScope, call: ToolCall): Promise<Result<ToolCall>>;

  // ---- ToolHealth ---------------------------------------------------------
  findHealth(
    scope: EnvironmentScope,
    toolId: ToolId,
    entityExternalId: ExternalEntityId | null,
  ): Promise<Result<ToolHealth | null>>;
  saveHealth(scope: EnvironmentScope, health: ToolHealth): Promise<Result<ToolHealth>>;

  // ---- ToolCallAudit ------------------------------------------------------
  /**
   * Append one audit row.
   *
   * The source swallows every failure here so an audit write can never fail the
   * tool call that produced it. That decision belongs to the CALLER, which is
   * why this returns a `Result` rather than eating it: `application/execute-tool.ts`
   * is where the swallow is written down, with its reason, once.
   */
  appendAudit(scope: EnvironmentScope, entry: AuditEntry): Promise<Result<AuditEntry>>;
  pageAudit(scope: EnvironmentScope, query: AuditQuery): Promise<Result<readonly AuditEntry[]>>;
}
