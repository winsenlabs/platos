// The `CriteriaRepository` port — the EvalCriterion table, seen as an interface.
//
// ADR M0.3 §1 row 14 makes this context the SOLE WRITER of `EvalCriterion`.
//
// THE UNIQUE CONSTRAINT IS ENFORCED BY THE STORE AND ASKED ABOUT BY THE USE
// CASE. `@@unique([environmentId, name])` means a create can lose a race even
// after `findByName` said the name was free, so `create` may answer
// `GOVERNANCE_CRITERION_ALREADY_EXISTS` on its own — the pre-check is a better
// error message, not the guarantee. An implementation MUST map the constraint
// violation to that code rather than letting a store exception escape.
//
// EVERY READ TAKES A SCOPE AND MUST RETURN NULL FOR A ROW IN ANOTHER
// ENVIRONMENT. `findById` on an id that exists elsewhere is `null`, never that
// row: the use case turns null into `GOVERNANCE_CRITERION_NOT_FOUND`, so a
// cross-tenant probe and a typo are indistinguishable to the caller.

import type { EnvironmentScope, Result, TransactionScope } from "@platos/kernel";

import type {
  ActorId,
  AdmittedCriterion,
  AgentId,
  EvalCriterion,
  EvalCriterionId,
} from "../../domain/index.js";

export interface CriterionQuery {
  readonly limit: number;
  readonly offset: number;
  /**
   * `undefined` does not filter at all. `null` matches only SHARED criteria. A
   * concrete id matches that agent's criteria PLUS the shared ones, which is the
   * "applies to this agent" view and is why this is not an equality.
   */
  readonly agentId?: AgentId | null;
  readonly activeOnly: boolean;
  readonly search: string | null;
}

export interface CriterionPage {
  readonly items: readonly EvalCriterion[];
  readonly total: number;
}

export interface CriteriaRepository {
  create(
    scope: EnvironmentScope,
    criterion: AdmittedCriterion,
    createdBy: ActorId,
    transaction: TransactionScope,
  ): Promise<Result<EvalCriterion>>;

  /** Replace a stored criterion with an already-admitted successor. */
  update(
    scope: EnvironmentScope,
    criterion: EvalCriterion,
    transaction: TransactionScope,
  ): Promise<Result<EvalCriterion>>;

  /**
   * Destroy one criterion, AND WITH IT EVERY EVAL TAKEN AGAINST IT.
   *
   * The canonical schema declares
   * `criterion EvalCriterion @relation(..., onDelete: Cascade)` on `AgentEval`,
   * so this is not a choice an implementation makes: the database does it. It is
   * stated here so no adapter is written believing `criterionSnapshot` keeps the
   * measurements — the snapshot survives an EDIT, not a DELETE — and so the
   * in-memory double is obliged to model the same cascade.
   */
  remove(
    scope: EnvironmentScope,
    criterionId: EvalCriterionId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  findById(scope: EnvironmentScope, criterionId: EvalCriterionId): Promise<Result<EvalCriterion | null>>;

  /** The uniqueness pre-check. Name matching is exact, not case-folded. */
  findByName(scope: EnvironmentScope, name: string): Promise<Result<EvalCriterion | null>>;

  page(scope: EnvironmentScope, query: CriterionQuery): Promise<Result<CriterionPage>>;

  /** Resolve several at once, for a rollup's labels. Missing ids are absent. */
  findMany(
    scope: EnvironmentScope,
    criterionIds: readonly EvalCriterionId[],
  ): Promise<Result<readonly EvalCriterion[]>>;
}
