// `Agent` and `AgentBinding` — the environment-scoped half of `AgentsRepository`.
//
// EVERY READ STARTS AT THE BINDING, because the port's unit is "this agent, in
// this environment" and an agent with no binding here is not present here. So
// the environment filter is on the row the read starts from rather than applied
// afterwards, and the project filter is a JOIN condition on the agent rather
// than a comparison made after the row is in hand: a lookup that finds the row
// first and checks the tenant second has already read another tenant's row, and
// the check is one edit away from being deleted.
//
// THE COST OF A BOUND READ IS FIXED BY ITS SHAPE, NOT BY THE NUMBER OF ROWS.
// MEASURED: the binding, then one statement per relation the client actually has
// to hydrate. A binding with a canary and a cluster costs five statements; one
// with neither costs three, because the client skips a relation whose foreign
// key is null. Twenty bindings cost exactly what one costs — the relations are
// loaded with `IN (…)`, not per row — and that, not the number five, is the
// property `agents-statements.integration.test.ts` pins.
//
// THE SEARCH TERM IS NOT HANDED TO A UUID COLUMN UNLESS IT IS ONE. See
// `looksLikeUuid` in `./agents-guards.js`: the driver refuses a malformed uuid
// rather than matching nothing, so an unguarded id filter turns every search for
// an ordinary word into a failed read.

import type {
  Agent,
  AgentBinding,
  AgentDefaultsPolicy,
  AgentId,
  AgentQuery,
  BoundAgent,
  BoundAgentPage,
  EnvironmentScope,
  ProjectId,
  Result,
  Slug,
  TransactionScope,
} from "@platos/context-agents/application/ports/index.js";
import { agentAlreadyExists, err, ok } from "@platos/context-agents/application/ports/index.js";

import {
  AGENT_MISSING,
  BINDING_ALREADY_EXISTS,
  BINDING_MOVED,
  CHECK_VIOLATION,
  checkRefusal,
  looksLikeUuid,
  namesConstraint,
  OWNER_KEY_IMMUTABLE,
  refusable,
  refused,
  sqlstateOf,
  UNIQUE_VIOLATION,
} from "./agents-guards.js";
import type { AgentBindingRow, AgentClusterRow, AgentRow, AgentVersionRowShape } from "./agents-rows.js";
import {
  AGENT_COLUMNS,
  BINDING_COLUMNS,
  CLUSTER_COLUMNS,
  toAgent,
  toBinding,
  toCluster,
  toVersion,
  VERSION_COLUMNS,
} from "./agents-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The four relations a `BoundAgent` is assembled from, PROJECTED.
 *
 * WIN-258 T7 TURNED THIS FROM AN `include` INTO A `select`. `activeAgentVersion:
 * true` asks the client for every column `AgentVersion` has, and six of them are
 * JSONB; a bound agent carries two versions, so a page of twenty cost forty
 * rows' worth of JSON documents whether or not the next migration's column has
 * anything to do with a version's content. The `BoundRow` interface below already
 * named the columns this module reads — an `include` made that a claim about the
 * TABLE, and the maps in `./agents-rows.js` make it a fact about the STATEMENT.
 *
 * Every one of the four is still hydrated in full, and that is not
 * over-hydration: `BoundAgent` publishes the whole of both versions and the whole
 * cluster. The projection is what stops the read WIDENING behind the assertion.
 */
const BOUND_SELECT = {
  ...BINDING_COLUMNS,
  agent: { select: AGENT_COLUMNS },
  activeAgentVersion: { select: VERSION_COLUMNS },
  canaryAgentVersion: { select: VERSION_COLUMNS },
  cluster: { select: CLUSTER_COLUMNS },
} as const;

/** `byListingOrder`, expressed over the joined agent so the store applies it. */
const LISTING_ORDER = [
  { agent: { createdAt: "desc" } },
  { agent: { id: "desc" } },
] as const;

interface BoundRow extends AgentBindingRow {
  readonly agent: AgentRow;
  readonly activeAgentVersion: AgentVersionRowShape;
  readonly canaryAgentVersion: AgentVersionRowShape | null;
  readonly cluster: AgentClusterRow | null;
}

export function toBoundAgent(row: BoundRow, defaults: AgentDefaultsPolicy): BoundAgent {
  return {
    agent: toAgent(row.agent),
    binding: toBinding(row),
    activeVersion: toVersion(row.activeAgentVersion, defaults),
    canaryVersion:
      row.canaryAgentVersion === null ? null : toVersion(row.canaryAgentVersion, defaults),
    cluster: row.cluster === null ? null : toCluster(row.cluster),
  };
}

/** Both halves of the scope, as one filter on the binding. */
function inScope(scope: EnvironmentScope) {
  return { environmentId: scope.environmentId, agent: { projectId: scope.projectId } };
}

function agentWriteRefusal(agent: Agent) {
  return (error: unknown) => {
    if (sqlstateOf(error) === UNIQUE_VIOLATION && namesConstraint(error, "projectId,slug")) {
      return agentAlreadyExists(agent.projectId, agent.slug);
    }
    if (sqlstateOf(error) === CHECK_VIOLATION && checkRefusal(error) === OWNER_KEY_IMMUTABLE) {
      return refused(OWNER_KEY_IMMUTABLE);
    }
    return null;
  };
}

function bindingWriteRefusal(error: unknown) {
  const sqlstate = sqlstateOf(error);
  if (sqlstate === UNIQUE_VIOLATION && namesConstraint(error, "environmentId,agentId")) {
    return refused(BINDING_ALREADY_EXISTS);
  }
  if (sqlstate === CHECK_VIOLATION) {
    const reason = checkRefusal(error);
    return reason === null ? null : refused(reason);
  }
  return null;
}

export function createAgentCatalog(
  transactions: TenancyTransactions,
  defaults: AgentDefaultsPolicy,
) {
  const bound = (row: BoundRow): BoundAgent => toBoundAgent(row, defaults);

  const bindingData = (binding: AgentBinding) => ({
    environmentId: binding.environmentId,
    agentId: binding.agentId,
    activeAgentVersionId: binding.activeVersionId,
    canaryAgentVersionId: binding.canaryVersionId,
    clusterId: binding.clusterId,
    canaryPercent: binding.canaryPercent,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  });

  return {
    async findBoundAgent(
      scope: EnvironmentScope,
      agentId: AgentId,
    ): Promise<Result<BoundAgent | null>> {
      const row = (await transactions.reader().agentBinding.findFirst({
        where: { ...inScope(scope), agentId },
        select: BOUND_SELECT,
      })) as BoundRow | null;
      return ok(row === null ? null : bound(row));
    },

    async findBoundAgentBySlug(
      scope: EnvironmentScope,
      slug: Slug,
    ): Promise<Result<BoundAgent | null>> {
      const row = (await transactions.reader().agentBinding.findFirst({
        where: { environmentId: scope.environmentId, agent: { projectId: scope.projectId, slug } },
        select: BOUND_SELECT,
      })) as BoundRow | null;
      return ok(row === null ? null : bound(row));
    },

    async listBoundAgents(scope: EnvironmentScope): Promise<Result<readonly BoundAgent[]>> {
      const rows = (await transactions.reader().agentBinding.findMany({
        where: inScope(scope),
        select: BOUND_SELECT,
        orderBy: [...LISTING_ORDER],
      })) as BoundRow[];
      return ok(rows.map(bound));
    },

    async pageBoundAgents(
      scope: EnvironmentScope,
      query: AgentQuery,
    ): Promise<Result<BoundAgentPage>> {
      const term = query.search;
      const agent = {
        projectId: scope.projectId,
        ...(query.active === null ? {} : { isActive: query.active }),
        ...(term === null
          ? {}
          : {
              OR: [
                { name: { contains: term, mode: "insensitive" as const } },
                { slug: { contains: term, mode: "insensitive" as const } },
                // Guarded, and the guard is the finding: an unguarded id filter
                // fails the whole read for any term that is not a uuid.
                ...(looksLikeUuid(term) ? [{ id: term }] : []),
              ],
            }),
      };
      const where = { environmentId: scope.environmentId, agent };
      const [rows, total] = await Promise.all([
        transactions.reader().agentBinding.findMany({
          where,
          select: BOUND_SELECT,
          orderBy: [...LISTING_ORDER],
          skip: query.offset,
          take: query.limit,
        }) as Promise<BoundRow[]>,
        transactions.reader().agentBinding.count({ where }),
      ]);
      return ok({ items: rows.map(bound), total });
    },

    async listProjectSlugs(projectId: ProjectId): Promise<Result<readonly string[]>> {
      const rows = await transactions
        .reader()
        .agent.findMany({ where: { projectId }, select: { slug: true } });
      return ok(rows.map((row) => row.slug));
    },

    async insertAgent(agent: Agent, transaction: TransactionScope): Promise<Result<Agent>> {
      const client = transactions.writer(transaction);
      const written = await refusable(
        client,
        () =>
          client.agent.create({
            data: {
              id: agent.agentId,
              projectId: agent.projectId,
              name: agent.name,
              slug: agent.slug,
              description: agent.description,
              isActive: agent.isActive,
              createdAt: agent.createdAt,
              updatedAt: agent.updatedAt,
            },
          }),
        agentWriteRefusal(agent),
      );
      return written.ok ? ok(toAgent(written.value)) : written;
    },

    async updateAgent(agent: Agent, transaction: TransactionScope): Promise<Result<Agent>> {
      const client = transactions.writer(transaction);
      // `projectId` IS written, and deliberately. `Agent_owner_immutable` refuses
      // an UPDATE that changes it, so sending the value the caller holds is what
      // turns "this record belongs to another project" into a refusal instead of
      // a silent move — which is what the in-memory double does today.
      const written = await refusable(
        client,
        () =>
          client.agent.updateManyAndReturn({
            where: { id: agent.agentId },
            data: {
              projectId: agent.projectId,
              name: agent.name,
              slug: agent.slug,
              description: agent.description,
              isActive: agent.isActive,
              updatedAt: agent.updatedAt,
            },
          }),
        agentWriteRefusal(agent),
      );
      if (!written.ok) return written;
      const row = written.value[0];
      return row === undefined ? err(refused(AGENT_MISSING)) : ok(toAgent(row));
    },

    async insertBinding(
      binding: AgentBinding,
      transaction: TransactionScope,
    ): Promise<Result<AgentBinding>> {
      const client = transactions.writer(transaction);
      const written = await refusable(
        client,
        () => client.agentBinding.create({ data: { id: binding.agentBindingId, ...bindingData(binding) } }),
        bindingWriteRefusal,
      );
      return written.ok ? ok(toBinding(written.value)) : written;
    },

    async updateBinding(
      binding: AgentBinding,
      transaction: TransactionScope,
    ): Promise<Result<AgentBinding>> {
      const client = transactions.writer(transaction);
      // SCOPED BY THE WHOLE IDENTITY THE CALLER READ, not by the primary key
      // alone: id, environment and agent together. A binding whose row has been
      // deleted, or whose id now names a different pairing, matches nothing and
      // is REFUSED rather than re-created. What this cannot do is notice that the
      // row's mutable columns moved — see the header of `agents-repository.ts`.
      const written = await refusable(
        client,
        () =>
          client.agentBinding.updateManyAndReturn({
            where: {
              id: binding.agentBindingId,
              environmentId: binding.environmentId,
              agentId: binding.agentId,
            },
            data: {
              activeAgentVersionId: binding.activeVersionId,
              canaryAgentVersionId: binding.canaryVersionId,
              clusterId: binding.clusterId,
              canaryPercent: binding.canaryPercent,
              updatedAt: binding.updatedAt,
            },
          }),
        bindingWriteRefusal,
      );
      if (!written.ok) return written;
      const row = written.value[0];
      return row === undefined ? err(refused(BINDING_MOVED)) : ok(toBinding(row));
    },

    async deleteBinding(
      scope: EnvironmentScope,
      binding: AgentBinding,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      const removed = await transactions.writer(transaction).agentBinding.deleteMany({
        where: { id: binding.agentBindingId, environmentId: scope.environmentId },
      });
      return ok(removed.count > 0);
    },

    async countBindings(
      agentId: AgentId,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      // Through `writer`, not `reader`: the caller counts AFTER its own delete
      // and inside the same transaction, so a count issued on the pool would see
      // the row the caller has just removed and answer one too many.
      return ok(await transactions.writer(transaction).agentBinding.count({ where: { agentId } }));
    },
  };
}
