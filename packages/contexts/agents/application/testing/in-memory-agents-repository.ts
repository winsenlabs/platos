// An in-memory `AgentsRepository`.
//
// IT ENFORCES WHAT THE STORE ENFORCES, NOT WHAT IS CONVENIENT. A double that
// accepted every write would let a use case pass here and fail in production, so
// this one refuses exactly what the schema refuses:
//
//   `@@unique([projectId, slug])`        two agents cannot share a slug.
//   `@@unique([agentId, versionNumber])` two versions cannot share a number.
//   `@@unique([environmentId, agentId])` one binding per agent per environment.
//   `@@unique([environmentId, slug])`    two clusters cannot share a slug.
//   `@@unique([agentVersionId, environmentSkillId])` one row per skill per version.
//
// AND IT ROUND-TRIPS EVERY VERSION THROUGH THE REAL ENVELOPE. A version is
// stored as the packed ROW — `packVersionRow` on the way in, `readVersionRow` on
// the way out — not as the snapshot it was handed. So every application test
// that reads a version back has exercised the `__runtime` envelope for real, and
// a field that failed to survive the round trip fails a use-case test rather
// than only the one domain test that looks at the envelope directly.

import { err, ok, type EnvironmentScope, type ProjectId, type Result, type TransactionScope } from "@platos/kernel";

import {
  agentAlreadyExists,
  asAgentsIdentifier,
  byClusterOrder,
  byListingOrder,
  byVersionOrder,
  clusterAlreadyExists,
  DEFAULT_AGENTS_POLICY,
  packVersionRow,
  readVersionRow,
  repositoryUnavailable,
  versionInvalid,
  type Agent,
  type AgentBinding,
  type AgentCluster,
  type AgentClusterId,
  type AgentId,
  type AgentSkill,
  type AgentSkillId,
  type AgentVersion,
  type AgentVersionId,
  type AgentsPolicy,
  type SkillAssignment,
  type Slug,
} from "../../domain/index.js";
import type {
  AgentQuery,
  AgentVersionPage,
  AgentsRepository,
  BoundAgent,
  BoundAgentPage,
} from "../ports/index.js";

/** The packed shape a version is actually held as. See the note at the top. */
interface StoredVersion {
  readonly agentVersionId: AgentVersionId;
  readonly agentId: AgentId;
  readonly row: ReturnType<typeof packVersionRow>;
  readonly createdAt: Date;
}

export class InMemoryAgentsRepository implements AgentsRepository {
  readonly agents = new Map<string, Agent>();
  readonly bindings = new Map<string, AgentBinding>();
  readonly clusters = new Map<string, AgentCluster>();
  private readonly versions = new Map<string, StoredVersion>();
  private readonly loadouts = new Map<string, AgentSkill[]>();
  private sequence = 0;

  /** Every write this double saw, in order. Tests assert on the sequence. */
  readonly writes: string[] = [];

  /**
   * When set, the next `deleteBinding` answers this error instead of deleting.
   *
   * A store that is up enough to be read and down by the time it is written is
   * the ONLY way to reach a use case's post-commit branches from a test, and
   * those branches are where the ordering rules live — `removeAgent` releases
   * thread holds only when the transaction actually committed, and a double
   * that could never fail a write would let that condition be deleted with the
   * suite still green. Set it, make the call, and the flag clears itself so a
   * test cannot leak an injected failure into the next one.
   */
  failNextDeleteBinding: string | null = null;

  constructor(private readonly policy: AgentsPolicy = DEFAULT_AGENTS_POLICY) {}

  // --- seeding -------------------------------------------------------------

  seedAgent(agent: Agent): Agent {
    this.agents.set(agent.agentId, agent);
    return agent;
  }

  seedVersion(version: AgentVersion): AgentVersion {
    this.store(version);
    return this.hydrate(this.versions.get(version.agentVersionId)!);
  }

  seedBinding(binding: AgentBinding): AgentBinding {
    this.bindings.set(binding.agentBindingId, binding);
    return binding;
  }

  seedCluster(cluster: AgentCluster): AgentCluster {
    this.clusters.set(cluster.clusterId, cluster);
    return cluster;
  }

  seedLoadout(versionId: AgentVersionId, assignments: readonly SkillAssignment[]): void {
    this.loadouts.set(versionId, assignments.map((assignment) => this.rowFor(versionId, assignment)));
  }

  private store(version: AgentVersion): void {
    this.versions.set(version.agentVersionId, {
      agentVersionId: version.agentVersionId,
      agentId: version.agentId,
      createdAt: version.createdAt,
      row: packVersionRow(
        version.snapshot,
        { createdBy: version.createdBy, note: version.note },
        version.versionNumber,
        version.toolDefaultPolicy,
        this.policy.defaults,
      ),
    });
  }

  private hydrate(stored: StoredVersion): AgentVersion {
    const row = stored.row;
    return {
      agentVersionId: stored.agentVersionId,
      agentId: stored.agentId,
      versionNumber: row.versionNumber,
      toolDefaultPolicy: row.toolDefaultPolicy,
      note: row.note,
      createdBy: row.createdBy,
      createdAt: stored.createdAt,
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
          outputSchema: row.outputSchema ?? null,
        },
        this.policy.defaults,
      ),
    };
  }

  private rowFor(versionId: AgentVersionId, assignment: SkillAssignment): AgentSkill {
    this.sequence += 1;
    const at = new Date(0);
    return {
      agentSkillId: asAgentsIdentifier<AgentSkillId>(`skill-row-${this.sequence}`),
      agentVersionId: versionId,
      environmentSkillId: assignment.environmentSkillId,
      enabled: assignment.enabled,
      config: assignment.config,
      createdAt: at,
      updatedAt: at,
    };
  }

  private bind(binding: AgentBinding): BoundAgent | null {
    const agent = this.agents.get(binding.agentId);
    const active = this.versions.get(binding.activeVersionId);
    if (agent === undefined || active === undefined) return null;
    const canary =
      binding.canaryVersionId === null ? undefined : this.versions.get(binding.canaryVersionId);
    return {
      agent,
      binding,
      activeVersion: this.hydrate(active),
      canaryVersion: canary === undefined ? null : this.hydrate(canary),
      cluster: binding.clusterId === null ? null : this.clusters.get(binding.clusterId) ?? null,
    };
  }

  private inScope(scope: EnvironmentScope): BoundAgent[] {
    const bound: BoundAgent[] = [];
    for (const binding of this.bindings.values()) {
      if (binding.environmentId !== scope.environmentId) continue;
      const resolved = this.bind(binding);
      // A binding whose agent belongs to another project is not this scope's,
      // however its environment reads. The store enforces this with a join; here
      // it is an explicit filter so a test can seed the mismatch on purpose.
      if (resolved === null || resolved.agent.projectId !== scope.projectId) continue;
      bound.push(resolved);
    }
    return bound.sort((left, right) => byListingOrder(left.agent, right.agent));
  }

  // --- AgentsRepository ----------------------------------------------------

  async findBoundAgent(scope: EnvironmentScope, agentId: AgentId): Promise<Result<BoundAgent | null>> {
    return ok(this.inScope(scope).find((bound) => bound.agent.agentId === agentId) ?? null);
  }

  async findBoundAgentBySlug(scope: EnvironmentScope, slug: Slug): Promise<Result<BoundAgent | null>> {
    return ok(this.inScope(scope).find((bound) => bound.agent.slug === slug) ?? null);
  }

  async listBoundAgents(scope: EnvironmentScope): Promise<Result<readonly BoundAgent[]>> {
    return ok(this.inScope(scope));
  }

  async pageBoundAgents(scope: EnvironmentScope, query: AgentQuery): Promise<Result<BoundAgentPage>> {
    const term = query.search === null ? null : query.search.toLowerCase();
    const matching = this.inScope(scope).filter((bound) => {
      if (query.active !== null && bound.agent.isActive !== query.active) return false;
      if (term === null) return true;
      return (
        bound.agent.name.toLowerCase().includes(term) ||
        bound.agent.slug.toLowerCase().includes(term) ||
        bound.agent.agentId === query.search
      );
    });
    return ok({
      items: matching.slice(query.offset, query.offset + query.limit),
      total: matching.length,
    });
  }

  async listProjectSlugs(projectId: ProjectId): Promise<Result<readonly string[]>> {
    return ok(
      [...this.agents.values()].filter((agent) => agent.projectId === projectId).map((agent) => agent.slug),
    );
  }

  async insertAgent(agent: Agent, transaction: TransactionScope): Promise<Result<Agent>> {
    this.writes.push(`insertAgent:${transaction.transactionId}`);
    const clash = [...this.agents.values()].some(
      (held) => held.projectId === agent.projectId && held.slug === agent.slug,
    );
    if (clash) return err(agentAlreadyExists(agent.projectId, agent.slug));
    this.agents.set(agent.agentId, agent);
    return ok(agent);
  }

  async updateAgent(agent: Agent, transaction: TransactionScope): Promise<Result<Agent>> {
    this.writes.push(`updateAgent:${transaction.transactionId}`);
    if (!this.agents.has(agent.agentId)) return err(repositoryUnavailable("agent_missing"));
    this.agents.set(agent.agentId, agent);
    return ok(agent);
  }

  async insertBinding(binding: AgentBinding, transaction: TransactionScope): Promise<Result<AgentBinding>> {
    this.writes.push(`insertBinding:${transaction.transactionId}`);
    const clash = [...this.bindings.values()].some(
      (held) => held.environmentId === binding.environmentId && held.agentId === binding.agentId,
    );
    if (clash) return err(repositoryUnavailable("binding_already_exists"));
    this.bindings.set(binding.agentBindingId, binding);
    return ok(binding);
  }

  async updateBinding(binding: AgentBinding, transaction: TransactionScope): Promise<Result<AgentBinding>> {
    this.writes.push(`updateBinding:${transaction.transactionId}`);
    if (!this.bindings.has(binding.agentBindingId)) return err(repositoryUnavailable("binding_missing"));
    this.bindings.set(binding.agentBindingId, binding);
    return ok(binding);
  }

  async deleteBinding(
    scope: EnvironmentScope,
    binding: AgentBinding,
    transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    this.writes.push(`deleteBinding:${transaction.transactionId}`);
    const injected = this.failNextDeleteBinding;
    if (injected !== null) {
      this.failNextDeleteBinding = null;
      return err(repositoryUnavailable(injected));
    }
    if (binding.environmentId !== scope.environmentId) return ok(false);
    return ok(this.bindings.delete(binding.agentBindingId));
  }

  async countBindings(agentId: AgentId, _transaction: TransactionScope): Promise<Result<number>> {
    return ok([...this.bindings.values()].filter((held) => held.agentId === agentId).length);
  }

  async findVersion(agentId: AgentId, versionId: AgentVersionId): Promise<Result<AgentVersion | null>> {
    const held = this.versions.get(versionId);
    // A version id belonging to a DIFFERENT agent answers null, not the row. The
    // store scopes the read by agent; a double that ignored it would let the
    // canary check pass for another agent's version.
    if (held === undefined || held.agentId !== agentId) return ok(null);
    return ok(this.hydrate(held));
  }

  async listVersions(agentId: AgentId): Promise<Result<readonly AgentVersion[]>> {
    return ok(this.ordered(agentId));
  }

  async pageVersions(
    agentId: AgentId,
    window: { readonly take: number; readonly offset: number; readonly cursor: string | null },
  ): Promise<Result<AgentVersionPage>> {
    const ordered = this.ordered(agentId);
    const start =
      window.cursor === null
        ? window.offset
        : ordered.findIndex((version) => version.agentVersionId === window.cursor) + 1;
    const page = ordered.slice(start, start + window.take);
    const hasMore = start + window.take < ordered.length;
    return ok({
      items: page,
      total: ordered.length,
      nextCursor: hasMore ? page[page.length - 1]?.agentVersionId ?? null : null,
    });
  }

  async observedVersionNumbers(
    agentId: AgentId,
    _transaction: TransactionScope,
  ): Promise<Result<readonly number[]>> {
    return ok(this.ordered(agentId).map((version) => version.versionNumber));
  }

  async insertVersion(version: AgentVersion, transaction: TransactionScope): Promise<Result<AgentVersion>> {
    this.writes.push(`insertVersion:${transaction.transactionId}`);
    const clash = this.ordered(version.agentId).some(
      (held) => held.versionNumber === version.versionNumber,
    );
    if (clash) {
      return err(
        versionInvalid("a version with that number already exists for this agent", {
          agentId: version.agentId,
          versionNumber: String(version.versionNumber),
        }),
      );
    }
    this.store(version);
    return ok(this.hydrate(this.versions.get(version.agentVersionId)!));
  }

  async listLoadout(agentVersionId: AgentVersionId): Promise<Result<readonly AgentSkill[]>> {
    return ok([...(this.loadouts.get(agentVersionId) ?? [])]);
  }

  async replaceLoadout(
    agentVersionId: AgentVersionId,
    assignments: readonly SkillAssignment[],
    transaction: TransactionScope,
  ): Promise<Result<readonly AgentSkill[]>> {
    this.writes.push(`replaceLoadout:${transaction.transactionId}`);
    const seen = new Set<string>();
    for (const assignment of assignments) {
      if (seen.has(assignment.environmentSkillId)) {
        return err(repositoryUnavailable("duplicate_environment_skill_in_loadout"));
      }
      seen.add(assignment.environmentSkillId);
    }
    const rows = assignments.map((assignment) => this.rowFor(agentVersionId, assignment));
    this.loadouts.set(agentVersionId, rows);
    return ok([...rows]);
  }

  async findCluster(scope: EnvironmentScope, clusterId: AgentClusterId): Promise<Result<AgentCluster | null>> {
    const held = this.clusters.get(clusterId);
    if (held === undefined || held.environmentId !== scope.environmentId) return ok(null);
    return ok(held);
  }

  async listClusters(scope: EnvironmentScope): Promise<Result<readonly AgentCluster[]>> {
    return ok(
      [...this.clusters.values()]
        .filter((cluster) => cluster.environmentId === scope.environmentId)
        .sort(byClusterOrder),
    );
  }

  async listClusterMembers(
    scope: EnvironmentScope,
    clusterId: AgentClusterId,
  ): Promise<Result<readonly AgentId[]>> {
    return ok(
      this.inScope(scope)
        .filter((bound) => bound.binding.clusterId === clusterId)
        .map((bound) => bound.agent.agentId),
    );
  }

  async insertCluster(cluster: AgentCluster, transaction: TransactionScope): Promise<Result<AgentCluster>> {
    this.writes.push(`insertCluster:${transaction.transactionId}`);
    const clash = [...this.clusters.values()].some(
      (held) => held.environmentId === cluster.environmentId && held.slug === cluster.slug,
    );
    if (clash) return err(clusterAlreadyExists(cluster.environmentId, cluster.slug));
    this.clusters.set(cluster.clusterId, cluster);
    return ok(cluster);
  }

  async updateCluster(cluster: AgentCluster, transaction: TransactionScope): Promise<Result<AgentCluster>> {
    this.writes.push(`updateCluster:${transaction.transactionId}`);
    if (!this.clusters.has(cluster.clusterId)) return err(repositoryUnavailable("cluster_missing"));
    this.clusters.set(cluster.clusterId, cluster);
    return ok(cluster);
  }

  async deleteCluster(
    scope: EnvironmentScope,
    clusterId: AgentClusterId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    this.writes.push(`deleteCluster:${transaction.transactionId}`);
    const held = this.clusters.get(clusterId);
    if (held === undefined || held.environmentId !== scope.environmentId) return ok(false);
    return ok(this.clusters.delete(clusterId));
  }

  async detachClusterMembers(
    scope: EnvironmentScope,
    clusterId: AgentClusterId,
    transaction: TransactionScope,
  ): Promise<Result<number>> {
    this.writes.push(`detachClusterMembers:${transaction.transactionId}`);
    let detached = 0;
    for (const [id, binding] of this.bindings) {
      if (binding.environmentId !== scope.environmentId || binding.clusterId !== clusterId) continue;
      this.bindings.set(id, { ...binding, clusterId: null });
      detached += 1;
    }
    return ok(detached);
  }

  private ordered(agentId: AgentId): AgentVersion[] {
    return [...this.versions.values()]
      .filter((held) => held.agentId === agentId)
      .map((held) => this.hydrate(held))
      .sort(byVersionOrder);
  }
}
