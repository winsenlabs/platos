// Use cases: golden-set authoring.
//
// The five CRUD paths. Every ceiling is checked at admission — see
// `domain/golden-set.ts` for why there are three of them and why an update
// re-admits the whole set rather than patching a list in place.
//
// THE AGENT MUST BE VISIBLE IN THIS ENVIRONMENT. A golden set names an agent,
// and `agents` is the only context that can say whether this environment has one
// bound. The source stores whatever `agentId` it is handed, so a set can name an
// agent that is not present here — a set that can never run and whose failure
// appears only when somebody runs it. It is refused at creation with
// `GOVERNANCE_AGENT_NOT_VISIBLE`, which is its own code because "no such agent
// here" and "no such golden set here" are different mistakes.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  admitGoldenSet,
  admitPage,
  agentNotVisible,
  applyGoldenSetPatch,
  goldenSetAlreadyExists,
  goldenSetNotFound,
  type ActorId,
  type AgentId,
  type GoldenSet,
  type GoldenSetDraft,
  type GoldenSetId,
  type GoldenSetPatch,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { GovernanceDependencies } from "./dependencies.js";

export interface CreateGoldenSetCommand {
  readonly authorization: unknown;
  readonly createdBy: ActorId;
  readonly set: GoldenSetDraft;
}

export interface UpdateGoldenSetCommand {
  readonly authorization: unknown;
  readonly goldenSetId: GoldenSetId;
  readonly patch: GoldenSetPatch;
}

export interface DescribeGoldenSetQuery {
  readonly authorization: unknown;
  readonly goldenSetId: GoldenSetId;
}

export interface PageGoldenSetsQuery {
  readonly authorization: unknown;
  readonly limit?: number | null;
  readonly offset?: number | null;
  readonly agentId?: AgentId | null;
}

export interface GoldenSetPageResult {
  readonly items: readonly GoldenSet[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export async function createGoldenSet(
  dependencies: GovernanceDependencies,
  command: CreateGoldenSetCommand,
): Promise<Result<GoldenSet>> {
  const grant = verifyOperator(dependencies, command.authorization);
  if (!grant.ok) return err(grant.error);
  const admitted = admitGoldenSet(command.set, dependencies.policy.goldenSets);
  if (!admitted.ok) return err(admitted.error);

  const visible = await requireVisibleAgent(dependencies, command.authorization, admitted.value.agentId);
  if (!visible.ok) return err(visible.error);

  const scope = grant.value.scope;
  const taken = await dependencies.goldenSets.findByName(scope, admitted.value.agentId, admitted.value.name);
  if (!taken.ok) return err(taken.error);
  if (taken.value !== null) {
    return err(goldenSetAlreadyExists(scope.environmentId, admitted.value.agentId, admitted.value.name));
  }
  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.goldenSets.create(scope, admitted.value, command.createdBy, transaction),
  );
}

export async function updateGoldenSet(
  dependencies: GovernanceDependencies,
  command: UpdateGoldenSetCommand,
): Promise<Result<GoldenSet>> {
  const grant = verifyOperator(dependencies, command.authorization);
  if (!grant.ok) return err(grant.error);
  const scope = grant.value.scope;
  const existing = await dependencies.goldenSets.findById(scope, command.goldenSetId);
  if (!existing.ok) return err(existing.error);
  if (existing.value === null) return err(goldenSetNotFound(command.goldenSetId));

  const patched = applyGoldenSetPatch(
    existing.value,
    command.patch,
    dependencies.policy.goldenSets,
    dependencies.clock.now(),
  );
  if (!patched.ok) return err(patched.error);

  if (patched.value.name !== existing.value.name) {
    const taken = await dependencies.goldenSets.findByName(scope, patched.value.agentId, patched.value.name);
    if (!taken.ok) return err(taken.error);
    if (taken.value !== null && taken.value.goldenSetId !== existing.value.goldenSetId) {
      return err(goldenSetAlreadyExists(scope.environmentId, patched.value.agentId, patched.value.name));
    }
  }
  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.goldenSets.update(scope, patched.value, transaction),
  );
}

export async function removeGoldenSet(
  dependencies: GovernanceDependencies,
  query: DescribeGoldenSetQuery,
): Promise<Result<boolean>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.goldenSets.remove(grant.value.scope, query.goldenSetId, transaction),
  );
}

export async function describeGoldenSet(
  dependencies: GovernanceDependencies,
  query: DescribeGoldenSetQuery,
): Promise<Result<GoldenSet>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const found = await dependencies.goldenSets.findById(grant.value.scope, query.goldenSetId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(goldenSetNotFound(query.goldenSetId));
  return ok(found.value);
}

export async function pageGoldenSets(
  dependencies: GovernanceDependencies,
  query: PageGoldenSetsQuery,
): Promise<Result<GoldenSetPageResult>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const page = admitPage(
    { limit: query.limit ?? null, offset: query.offset ?? null },
    dependencies.policy.criteria,
  );
  if (!page.ok) return err(page.error);
  const read = await dependencies.goldenSets.page(grant.value.scope, {
    limit: page.value.limit,
    offset: page.value.offset,
    agentId: query.agentId ?? null,
  });
  if (!read.ok) return err(read.error);
  return ok({
    items: read.value.items,
    total: read.value.total,
    limit: page.value.limit,
    offset: page.value.offset,
  });
}

/** `agents` is the only context that can say an agent is bound here. */
export async function requireVisibleAgent(
  dependencies: GovernanceDependencies,
  authorization: unknown,
  agentId: AgentId,
): Promise<Result<AgentId>> {
  const described = await dependencies.agents.describeAgent({ authorization, agentId });
  if (!described.ok) return err(agentNotVisible(agentId));
  return ok(agentId);
}
