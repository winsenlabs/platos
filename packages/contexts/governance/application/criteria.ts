// Use cases: eval criterion authoring.
//
// The five CRUD paths, each taking its environment from the grant.
//
// THE UNIQUENESS CHECK IS A BETTER ERROR, NOT THE GUARANTEE.
// `@@unique([environmentId, name])` is enforced by the store; `findByName` runs
// first so the common case reads as a conflict rather than as a constraint
// violation, and the repository port documents that an implementation MUST map
// the violation to the same code when the race is lost. A pre-check presented as
// the guarantee is how duplicate rows appear under load.
//
// THE UPDATE RE-ADMITS THE WHOLE CRITERION. The source patches each supplied
// field independently, so raising `scoreScaleMin` above an untouched
// `scoreScaleMax` stores a criterion whose every future score normalises to
// zero — an agent that appears to fail everything, with no error anywhere.
// `applyCriterionPatch` re-admits the merged value, so a patch is judged against
// the criterion as it will be STORED.
//
// THE UPDATE IS ALSO SCOPED TWICE, AND ON PURPOSE. The source reads the row
// through a scoped query and then writes `update({ where: { id } })` with no
// scope at all: correct today because the read gated it, and one refactor away
// from a cross-tenant write. Here the scope is passed to the repository on the
// write as well, so the narrowing does not depend on the order of two statements
// in one function.
//
// DELETING A CRITERION DOES NOT DELETE ITS EVALS, and that is the point of the
// snapshot: past measurements keep the question they were taken against. The
// aggregate reports such a bucket with a null criterion name rather than dropping
// it, which would silently improve the average every time an operator tidied up.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitCriterion,
  admitPage,
  applyCriterionPatch,
  criterionAlreadyExists,
  criterionNotFound,
  type ActorId,
  type AgentId,
  type CriterionDraft,
  type CriterionPatch,
  type EvalCriterion,
  type EvalCriterionId,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { GovernanceDependencies } from "./dependencies.js";

export interface CreateCriterionCommand {
  readonly authorization: unknown;
  readonly createdBy: ActorId;
  readonly criterion: CriterionDraft;
}

export interface UpdateCriterionCommand {
  readonly authorization: unknown;
  readonly criterionId: EvalCriterionId;
  readonly patch: CriterionPatch;
}

export interface DescribeCriterionQuery {
  readonly authorization: unknown;
  readonly criterionId: EvalCriterionId;
}

export interface PageCriteriaQuery {
  readonly authorization: unknown;
  readonly limit?: number | null;
  readonly offset?: number | null;
  /** Absent does not filter; null matches shared criteria only. */
  readonly agentId?: AgentId | null;
  readonly activeOnly?: boolean;
  readonly search?: string | null;
}

export interface CriterionPageResult {
  readonly items: readonly EvalCriterion[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export async function createCriterion(
  dependencies: GovernanceDependencies,
  command: CreateCriterionCommand,
): Promise<Result<EvalCriterion>> {
  const grant = verifyOperator(dependencies, command.authorization);
  if (!grant.ok) return err(grant.error);
  const admitted = admitCriterion(command.criterion, dependencies.policy.criteria);
  if (!admitted.ok) return err(admitted.error);

  const scope = grant.value.scope;
  const taken = await dependencies.criteria.findByName(scope, admitted.value.name);
  if (!taken.ok) return err(taken.error);
  if (taken.value !== null) {
    return err(criterionAlreadyExists(scope.environmentId, admitted.value.name));
  }
  return dependencies.unitOfWork.run((transaction) =>
    dependencies.criteria.create(scope, admitted.value, command.createdBy, transaction),
  );
}

export async function updateCriterion(
  dependencies: GovernanceDependencies,
  command: UpdateCriterionCommand,
): Promise<Result<EvalCriterion>> {
  const grant = verifyOperator(dependencies, command.authorization);
  if (!grant.ok) return err(grant.error);
  const scope = grant.value.scope;
  const existing = await dependencies.criteria.findById(scope, command.criterionId);
  if (!existing.ok) return err(existing.error);
  if (existing.value === null) return err(criterionNotFound(command.criterionId));

  const patched = applyCriterionPatch(
    existing.value,
    command.patch,
    dependencies.policy.criteria,
    dependencies.clock.now(),
  );
  if (!patched.ok) return err(patched.error);

  if (patched.value.name !== existing.value.name) {
    const taken = await dependencies.criteria.findByName(scope, patched.value.name);
    if (!taken.ok) return err(taken.error);
    if (taken.value !== null && taken.value.evalCriterionId !== existing.value.evalCriterionId) {
      return err(criterionAlreadyExists(scope.environmentId, patched.value.name));
    }
  }
  return dependencies.unitOfWork.run((transaction) =>
    dependencies.criteria.update(scope, patched.value, transaction),
  );
}

export async function removeCriterion(
  dependencies: GovernanceDependencies,
  query: DescribeCriterionQuery,
): Promise<Result<boolean>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  return dependencies.unitOfWork.run((transaction) =>
    dependencies.criteria.remove(grant.value.scope, query.criterionId, transaction),
  );
}

export async function describeCriterion(
  dependencies: GovernanceDependencies,
  query: DescribeCriterionQuery,
): Promise<Result<EvalCriterion>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const found = await dependencies.criteria.findById(grant.value.scope, query.criterionId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(criterionNotFound(query.criterionId));
  return ok(found.value);
}

export async function pageCriteria(
  dependencies: GovernanceDependencies,
  query: PageCriteriaQuery,
): Promise<Result<CriterionPageResult>> {
  const grant = verifyOperator(dependencies, query.authorization);
  if (!grant.ok) return err(grant.error);
  const page = admitPage(
    { limit: query.limit ?? null, offset: query.offset ?? null },
    dependencies.policy.criteria,
  );
  if (!page.ok) return err(page.error);
  const read = await dependencies.criteria.page(grant.value.scope, {
    limit: page.value.limit,
    offset: page.value.offset,
    ...("agentId" in query ? { agentId: query.agentId ?? null } : {}),
    activeOnly: query.activeOnly ?? false,
    search: blankToNull(query.search ?? null),
  });
  if (!read.ok) return err(read.error);
  return ok({
    items: read.value.items,
    total: read.value.total,
    limit: page.value.limit,
    offset: page.value.offset,
  });
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
