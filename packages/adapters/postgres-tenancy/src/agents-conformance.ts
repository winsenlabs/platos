// One scenario over `AgentsRepository`, written once, so the in-memory double
// and this adapter can be asked the SAME questions and their answers compared.
//
// WHY A SHARED SCENARIO RATHER THAN TWO SUITES. `InMemoryAgentsRepository` says
// in its own header that it "enforces what the store enforces, not what is
// convenient", and lists five unique indexes it upholds. That is a claim about a
// second implementation, and two independently written suites would measure two
// things and agree by coincidence. This module drives one sequence of port calls
// and records what came back; a test runs it twice and compares. A divergence is
// then a named step with two values, not "the adapter behaves differently".
//
// WHAT IS NORMALISED, AND WHY IT IS ONLY THIS. `replaceLoadout` mints an
// `AgentSkill` id and two timestamps that the port never asked the caller for —
// the double counts, PostgreSQL generates a uuid and `now()` — so a loadout is
// recorded as the assignment it carries plus the fact that an id exists.
// Everything else compares literally: every returned record, every error code and
// its details, every count, every ordering and every null.
//
// THE IDS ARE UUIDS EVEN THOUGH THE DOUBLE WOULD TAKE ANYTHING. They are handed
// in from outside so each store can use its own, and they have to be a shape
// PostgreSQL will accept, which is the first thing this scenario found: the
// readable labels a double invites are refused by a `@db.Uuid` column.

import type {
  Agent,
  AgentBinding,
  AgentCluster,
  AgentDefaultsPolicy,
  AgentsRepository,
  AgentVersion,
  AgentVersionSnapshot,
  EnvironmentScope,
  Result,
  SkillAssignment,
  UnitOfWork,
} from "@platos/context-agents/application/ports/index.js";
import { buildSnapshot } from "@platos/context-agents/application/ports/index.js";

/** One step of the scenario: what was asked, and what came back. */
export interface Observation {
  readonly step: string;
  readonly value: unknown;
}

/** Every identifier the scenario needs, so each store can be handed its own. */
export interface AgentsScenarioIds {
  readonly firstAgent: string;
  readonly firstVersion: string;
  readonly firstBinding: string;
  readonly secondVersion: string;
  readonly secondAgent: string;
  readonly secondAgentVersion: string;
  readonly secondAgentBinding: string;
  readonly cluster: string;
  readonly clashingAgent: string;
  readonly clashingVersion: string;
  readonly clashingCluster: string;
}

export interface AgentsScenarioStores {
  readonly repository: AgentsRepository;
  readonly unitOfWork: UnitOfWork;
  /** The two `EnvironmentSkill` ids a loadout may name in the home scope. */
  readonly firstSkill: string;
  readonly secondSkill: string;
}

const AT = new Date("2026-05-01T09:00:00.000Z");
const LATER = new Date("2026-05-02T09:00:00.000Z");

/** A snapshot with every field at its policy default, plus any overrides. */
export function buildAgentsScenarioSnapshot(
  defaults: AgentDefaultsPolicy,
  overrides: Partial<AgentVersionSnapshot> = {},
): AgentVersionSnapshot {
  return { ...buildSnapshot({ model: "openai:gpt-4o" }, defaults), ...overrides };
}

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

/** A loadout row, with the two values the STORE mints replaced by their shape. */
function loadoutShape(skills: readonly { readonly agentSkillId: string; readonly environmentSkillId: string; readonly enabled: boolean; readonly config: unknown; readonly agentVersionId: string }[]) {
  return skills.map((skill) => ({
    agentVersionId: skill.agentVersionId,
    environmentSkillId: skill.environmentSkillId,
    enabled: skill.enabled,
    config: skill.config,
    hasMintedId: skill.agentSkillId.length > 0,
  }));
}

/** A `Result`, recorded so a refusal compares by code and details, not by class. */
function outcome(result: Result<unknown>): unknown {
  if (result.ok) return { ok: true, value: result.value };
  return {
    ok: false,
    code: result.error.code,
    category: result.error.category,
    details: result.error.details,
  };
}

export async function runAgentsScenario(
  stores: AgentsScenarioStores,
  ids: AgentsScenarioIds,
  scopes: { readonly home: EnvironmentScope; readonly peer: EnvironmentScope },
  defaults: AgentDefaultsPolicy,
): Promise<readonly Observation[]> {
  const seen: Observation[] = [];
  const record = (step: string, value: unknown): void => {
    seen.push({ step, value });
  };
  const { repository, unitOfWork } = stores;

  const agent: Agent = {
    agentId: tag(ids.firstAgent),
    projectId: scopes.home.projectId,
    name: "First",
    slug: tag("first"),
    description: null,
    isActive: true,
    createdAt: AT,
    updatedAt: AT,
  };
  const version: AgentVersion = {
    agentVersionId: tag(ids.firstVersion),
    agentId: agent.agentId,
    versionNumber: 1,
    toolDefaultPolicy: "NONE",
    note: "Initial version",
    createdBy: tag("operator-1"),
    createdAt: AT,
    snapshot: buildAgentsScenarioSnapshot(defaults, { systemPrompt: "be brief" }),
  };
  const binding: AgentBinding = {
    agentBindingId: tag(ids.firstBinding),
    environmentId: scopes.home.environmentId,
    agentId: agent.agentId,
    activeVersionId: version.agentVersionId,
    canaryVersionId: null,
    clusterId: null,
    canaryPercent: 0,
    createdAt: AT,
    updatedAt: AT,
  };

  await unitOfWork.run(async (transaction) => {
    record("insertAgent", outcome(await repository.insertAgent(agent, transaction)));
    record("insertVersion", outcome(await repository.insertVersion(version, transaction)));
    record("insertBinding", outcome(await repository.insertBinding(binding, transaction)));
  });

  record("findBoundAgent home", outcome(await repository.findBoundAgent(scopes.home, agent.agentId)));
  record("findBoundAgent peer", outcome(await repository.findBoundAgent(scopes.peer, agent.agentId)));
  record("findBoundAgentBySlug", outcome(await repository.findBoundAgentBySlug(scopes.home, agent.slug)));
  record(
    "findBoundAgentBySlug unknown",
    outcome(await repository.findBoundAgentBySlug(scopes.home, tag("nobody"))),
  );
  record("listProjectSlugs", outcome(await repository.listProjectSlugs(scopes.home.projectId)));

  await unitOfWork.run(async (transaction) => {
    record(
      "insertAgent with a slug already taken",
      outcome(
        await repository.insertAgent(
          { ...agent, agentId: tag(ids.clashingAgent), createdAt: LATER, updatedAt: LATER },
          transaction,
        ),
      ),
    );
  });

  const second: Agent = {
    ...agent,
    agentId: tag(ids.secondAgent),
    name: "Second",
    slug: tag("second"),
    isActive: false,
    createdAt: LATER,
    updatedAt: LATER,
  };
  const secondVersion: AgentVersion = {
    ...version,
    agentVersionId: tag(ids.secondAgentVersion),
    agentId: second.agentId,
    createdAt: LATER,
  };
  await unitOfWork.run(async (transaction) => {
    await repository.insertAgent(second, transaction);
    await repository.insertVersion(secondVersion, transaction);
    await repository.insertBinding(
      {
        ...binding,
        agentBindingId: tag(ids.secondAgentBinding),
        agentId: second.agentId,
        activeVersionId: secondVersion.agentVersionId,
        createdAt: LATER,
        updatedAt: LATER,
      },
      transaction,
    );
  });

  record("listBoundAgents", outcome(await repository.listBoundAgents(scopes.home)));
  record(
    "pageBoundAgents first page",
    outcome(
      await repository.pageBoundAgents(scopes.home, { limit: 1, offset: 0, search: null, active: null }),
    ),
  );
  record(
    "pageBoundAgents active only",
    outcome(
      await repository.pageBoundAgents(scopes.home, { limit: 10, offset: 0, search: null, active: true }),
    ),
  );
  record(
    "pageBoundAgents search by name",
    outcome(
      await repository.pageBoundAgents(scopes.home, { limit: 10, offset: 0, search: "SEC", active: null }),
    ),
  );
  // A term that is not a uuid. The double compares two strings; the driver
  // refuses a malformed uuid and fails the WHOLE read, so an unguarded id filter
  // would make this step an exception rather than an empty page.
  record(
    "pageBoundAgents search by a term that is not an identifier",
    outcome(
      await repository.pageBoundAgents(scopes.home, {
        limit: 10,
        offset: 0,
        search: "no-such-agent",
        active: null,
      }),
    ),
  );
  record(
    "pageBoundAgents search by id",
    outcome(
      await repository.pageBoundAgents(scopes.home, {
        limit: 10,
        offset: 0,
        search: ids.secondAgent,
        active: null,
      }),
    ),
  );

  const nextVersion: AgentVersion = {
    ...version,
    agentVersionId: tag(ids.secondVersion),
    versionNumber: 2,
    note: "Second",
    createdAt: LATER,
    snapshot: buildAgentsScenarioSnapshot(defaults, { systemPrompt: "be briefer", maxSteps: 12 }),
  };
  await unitOfWork.run(async (transaction) => {
    record(
      "observedVersionNumbers",
      outcome(await repository.observedVersionNumbers(agent.agentId, transaction)),
    );
    record("insertVersion second", outcome(await repository.insertVersion(nextVersion, transaction)));
    record(
      "observedVersionNumbers after",
      outcome(await repository.observedVersionNumbers(agent.agentId, transaction)),
    );
  });
  await unitOfWork.run(async (transaction) => {
    record(
      "insertVersion re-using a number",
      outcome(
        await repository.insertVersion(
          { ...nextVersion, agentVersionId: tag(ids.clashingVersion), versionNumber: 1 },
          transaction,
        ),
      ),
    );
  });

  record("findVersion", outcome(await repository.findVersion(agent.agentId, nextVersion.agentVersionId)));
  record(
    "findVersion belonging to another agent",
    outcome(await repository.findVersion(second.agentId, nextVersion.agentVersionId)),
  );
  record("listVersions", outcome(await repository.listVersions(agent.agentId)));
  const firstPage = await repository.pageVersions(agent.agentId, {
    take: 1,
    offset: 0,
    cursor: null,
  });
  record("pageVersions first", outcome(firstPage));
  record(
    "pageVersions by cursor",
    outcome(
      await repository.pageVersions(agent.agentId, {
        take: 1,
        offset: 0,
        cursor: firstPage.ok ? firstPage.value.nextCursor : null,
      }),
    ),
  );

  const loadout: readonly SkillAssignment[] = [
    { environmentSkillId: tag(stores.firstSkill), enabled: true, config: { a: 1 } },
    { environmentSkillId: tag(stores.secondSkill), enabled: false, config: {} },
  ];
  await unitOfWork.run(async (transaction) => {
    const written = await repository.replaceLoadout(nextVersion.agentVersionId, loadout, transaction);
    record("replaceLoadout", written.ok ? loadoutShape(written.value as never) : outcome(written));
  });
  const held = await repository.listLoadout(nextVersion.agentVersionId);
  record("listLoadout", held.ok ? loadoutShape(held.value as never) : outcome(held));
  await unitOfWork.run(async (transaction) => {
    const shortened = await repository.replaceLoadout(
      nextVersion.agentVersionId,
      [loadout[0]!],
      transaction,
    );
    record("replaceLoadout shorter", shortened.ok ? loadoutShape(shortened.value as never) : outcome(shortened));
  });
  await unitOfWork.run(async (transaction) => {
    record(
      "replaceLoadout naming one skill twice",
      outcome(
        await repository.replaceLoadout(
          nextVersion.agentVersionId,
          [loadout[0]!, loadout[0]!],
          transaction,
        ),
      ),
    );
  });

  const moved: AgentBinding = {
    ...binding,
    activeVersionId: nextVersion.agentVersionId,
    updatedAt: LATER,
  };
  await unitOfWork.run(async (transaction) => {
    record("updateBinding", outcome(await repository.updateBinding(moved, transaction)));
  });
  record("findBoundAgent after the move", outcome(await repository.findBoundAgent(scopes.home, agent.agentId)));

  const cluster: AgentCluster = {
    clusterId: tag(ids.cluster),
    environmentId: scopes.home.environmentId,
    name: "Fleet",
    slug: tag("fleet"),
    description: null,
    metadata: null,
    createdAt: AT,
    updatedAt: AT,
  };
  await unitOfWork.run(async (transaction) => {
    record("insertCluster", outcome(await repository.insertCluster(cluster, transaction)));
  });
  await unitOfWork.run(async (transaction) => {
    record(
      "insertCluster with a slug already taken",
      outcome(
        await repository.insertCluster({ ...cluster, clusterId: tag(ids.clashingCluster) }, transaction),
      ),
    );
  });
  record("findCluster home", outcome(await repository.findCluster(scopes.home, cluster.clusterId)));
  record("findCluster peer", outcome(await repository.findCluster(scopes.peer, cluster.clusterId)));
  record("listClusters", outcome(await repository.listClusters(scopes.home)));
  await unitOfWork.run(async (transaction) => {
    record(
      "updateCluster",
      outcome(await repository.updateCluster({ ...cluster, name: "Renamed", updatedAt: LATER }, transaction)),
    );
    record(
      "updateBinding into the cluster",
      outcome(
        await repository.updateBinding({ ...moved, clusterId: cluster.clusterId }, transaction),
      ),
    );
  });
  record("listClusterMembers", outcome(await repository.listClusterMembers(scopes.home, cluster.clusterId)));
  await unitOfWork.run(async (transaction) => {
    record(
      "detachClusterMembers",
      outcome(await repository.detachClusterMembers(scopes.home, cluster.clusterId, transaction)),
    );
    record(
      "deleteCluster from the wrong environment",
      outcome(await repository.deleteCluster(scopes.peer, cluster.clusterId, transaction)),
    );
    record(
      "deleteCluster",
      outcome(await repository.deleteCluster(scopes.home, cluster.clusterId, transaction)),
    );
  });

  await unitOfWork.run(async (transaction) => {
    record(
      "updateAgent",
      outcome(await repository.updateAgent({ ...agent, name: "Renamed", updatedAt: LATER }, transaction)),
    );
    record("countBindings", outcome(await repository.countBindings(agent.agentId, transaction)));
    record(
      "deleteBinding from the wrong environment",
      outcome(await repository.deleteBinding(scopes.peer, moved, transaction)),
    );
    record("deleteBinding", outcome(await repository.deleteBinding(scopes.home, moved, transaction)));
    record("countBindings after", outcome(await repository.countBindings(agent.agentId, transaction)));
  });
  record("findBoundAgent after the delete", outcome(await repository.findBoundAgent(scopes.home, agent.agentId)));

  return seen;
}
