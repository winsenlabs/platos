// The `AgentsRepository` port — the canonical store, seen only as an interface.
//
// ADR M0.3 §1 row 5 makes this context the SOLE WRITER of `Agent`,
// `AgentCluster`, `AgentVersion`, `AgentBinding` and `AgentSkill`. This port is
// where that ownership is expressed: every mutation of those five tables in the
// V1 system passes through one of the methods below, and there is deliberately
// no generic `save(row)` or `query(where)` escape hatch another context could
// reach sideways.
//
// THREE SCOPING REGIMES, ON PURPOSE, BECAUSE THE SCHEMA HAS THREE.
//
//   `Agent` and `AgentVersion` hang off PROJECT. One agent is visible to every
//   environment in its project; its versions are not environment-scoped at all.
//   That is why `findVersion` takes an agent id and not a scope: narrowing a
//   version by environment would be a lie, and a lie that silently returns
//   nothing.
//
//   `AgentBinding` and `AgentCluster` are ENVIRONMENT-scoped. Every read takes an
//   `EnvironmentScope`, and an implementation MUST return `null` — never a row
//   from another environment — when an id exists elsewhere.
//
//   `AgentSkill` hangs off a VERSION, which is the narrowest regime of the three
//   and the reason the loadout has to be carried forward on every save.
//
// SO EVERY AGENT READ GOES THROUGH THE BINDING. `BoundAgent` is the unit,
// because "this agent, in this environment" is the only question a surface ever
// asks: an agent with no binding here is not present here, whatever its project
// says. That is also what makes the environment scope a real filter rather than
// a decoration.
//
// THE AUTHORIZATION IS NOT A PARAMETER HERE. A use case verifies the grant it
// was handed and derives the scope from it (never from an id the caller also
// supplied), then passes the derived scope down. That keeps this port free of a
// peer context's types, which matters because its adapter is shared.
//
// EVERY MUTATION TAKES A `TransactionScope`. The kernel's handle is opaque by
// construction (ADR M0.3 §3: no context passes a vendor transaction handle
// across a port), which is what lets a version write, a binding move and an
// outbox append be atomic without either side naming the other's technology.
//
// EVERY METHOD RETURNS `Result`. A rejected promise is a defect, not an outcome.

import type { EnvironmentScope, ProjectId, Result, TransactionScope } from "@platos/kernel";

import type {
  Agent,
  AgentBinding,
  AgentCluster,
  AgentClusterId,
  AgentId,
  AgentSkill,
  AgentVersion,
  AgentVersionId,
  SkillAssignment,
  Slug,
} from "../../domain/index.js";

/** One agent as it exists in one environment: the row, its binding, its versions. */
export interface BoundAgent {
  readonly agent: Agent;
  readonly binding: AgentBinding;
  readonly activeVersion: AgentVersion;
  /** Null when nothing is in canary, or when the canary row has since gone. */
  readonly canaryVersion: AgentVersion | null;
  readonly cluster: AgentCluster | null;
}

export interface BoundAgentPage {
  readonly items: readonly BoundAgent[];
  readonly total: number;
}

export interface AgentQuery {
  readonly limit: number;
  readonly offset: number;
  /**
   * Case-insensitive substring across name and slug, plus an exact id match when
   * the term looks like one. Null means no filter; an empty string is NOT the
   * same as null and is rejected by the use case before it reaches here.
   */
  readonly search: string | null;
  /** `true` for active only, `false` for paused only, null for both. */
  readonly active: boolean | null;
}

export interface AgentVersionPage {
  readonly items: readonly AgentVersion[];
  readonly total: number;
  /** The id to resume from, or null at the end of the listing. */
  readonly nextCursor: string | null;
}

export interface AgentsRepository {
  // --- Agent + AgentBinding: environment-scoped reads, sole-writer -----------

  findBoundAgent(scope: EnvironmentScope, agentId: AgentId): Promise<Result<BoundAgent | null>>;

  findBoundAgentBySlug(scope: EnvironmentScope, slug: Slug): Promise<Result<BoundAgent | null>>;

  listBoundAgents(scope: EnvironmentScope): Promise<Result<readonly BoundAgent[]>>;

  /**
   * One page, in `byListingOrder`. An implementation MUST apply that exact
   * order, including its final id tie-break: a paged listing whose order is not
   * total silently drops and repeats rows across pages.
   */
  pageBoundAgents(scope: EnvironmentScope, query: AgentQuery): Promise<Result<BoundAgentPage>>;

  /**
   * The slugs already taken in a project.
   *
   * A project-wide read from an environment-scoped use case, and deliberately
   * so: `@@unique([projectId, slug])` is a PROJECT constraint, and checking it
   * against one environment's agents would let two environments in the same
   * project both believe a slug is free.
   */
  listProjectSlugs(projectId: ProjectId): Promise<Result<readonly string[]>>;

  insertAgent(agent: Agent, transaction: TransactionScope): Promise<Result<Agent>>;

  updateAgent(agent: Agent, transaction: TransactionScope): Promise<Result<Agent>>;

  insertBinding(binding: AgentBinding, transaction: TransactionScope): Promise<Result<AgentBinding>>;

  /**
   * Move a binding.
   *
   * The source takes a row lock on `[environmentId, agentId]` before it reads,
   * so two concurrent saves serialise instead of both minting a version against
   * the same parent. That lock is the implementation's; what this port
   * guarantees is that a binding update is a compare-and-move on the row the
   * caller read, and an implementation MUST refuse rather than clobber when the
   * row moved underneath it.
   */
  updateBinding(binding: AgentBinding, transaction: TransactionScope): Promise<Result<AgentBinding>>;

  deleteBinding(
    scope: EnvironmentScope,
    binding: AgentBinding,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  /**
   * How many environments still bind this agent.
   *
   * A COUNT rather than a boolean because the caller does not ask "is it bound
   * anywhere" — it asks whether THIS removal was the last one, and the answer
   * has to be read after the delete inside the same transaction.
   */
  countBindings(agentId: AgentId, transaction: TransactionScope): Promise<Result<number>>;

  // --- AgentVersion: project-scoped, immutable, sole-writer -----------------

  findVersion(agentId: AgentId, versionId: AgentVersionId): Promise<Result<AgentVersion | null>>;

  listVersions(agentId: AgentId): Promise<Result<readonly AgentVersion[]>>;

  /** One page, in `byVersionOrder`. Cursor and offset are mutually exclusive. */
  pageVersions(
    agentId: AgentId,
    window: { readonly take: number; readonly offset: number; readonly cursor: string | null },
  ): Promise<Result<AgentVersionPage>>;

  /**
   * Every version number this agent has used, read inside the write.
   *
   * Numbers and not a count: a pruned history has gaps, and counting rows would
   * re-issue a number an old version already used. `@@unique([agentId,
   * versionNumber])` is the last line of defence and an implementation MUST
   * surface a violation rather than shifting the number to the next free one.
   */
  observedVersionNumbers(agentId: AgentId, transaction: TransactionScope): Promise<Result<readonly number[]>>;

  insertVersion(version: AgentVersion, transaction: TransactionScope): Promise<Result<AgentVersion>>;

  // --- AgentSkill: version-scoped, sole-writer ------------------------------

  listLoadout(agentVersionId: AgentVersionId): Promise<Result<readonly AgentSkill[]>>;

  /**
   * Write a version's WHOLE loadout.
   *
   * Not an upsert-per-skill: a version's loadout is written once, when the
   * version is created, and a partial write would leave a live version carrying
   * half of two configurations. Callers that change one skill compute the whole
   * next list with `applyLoadoutChange` and hand it here.
   */
  replaceLoadout(
    agentVersionId: AgentVersionId,
    assignments: readonly SkillAssignment[],
    transaction: TransactionScope,
  ): Promise<Result<readonly AgentSkill[]>>;

  // --- AgentCluster: environment-scoped, sole-writer ------------------------

  findCluster(scope: EnvironmentScope, clusterId: AgentClusterId): Promise<Result<AgentCluster | null>>;

  listClusters(scope: EnvironmentScope): Promise<Result<readonly AgentCluster[]>>;

  /** The agents bound into a cluster, in the store's own order. */
  listClusterMembers(scope: EnvironmentScope, clusterId: AgentClusterId): Promise<Result<readonly AgentId[]>>;

  insertCluster(cluster: AgentCluster, transaction: TransactionScope): Promise<Result<AgentCluster>>;

  updateCluster(cluster: AgentCluster, transaction: TransactionScope): Promise<Result<AgentCluster>>;

  /**
   * Remove a cluster, having already detached its members.
   *
   * Detaching is a separate call because it is a binding write, and a binding is
   * a different row with a different owner-check. Folding it in here would hide
   * a multi-row mutation behind a name that reads like a single delete.
   */
  deleteCluster(
    scope: EnvironmentScope,
    clusterId: AgentClusterId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  /** Clear `clusterId` on every binding in this environment that names it. */
  detachClusterMembers(
    scope: EnvironmentScope,
    clusterId: AgentClusterId,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
}
