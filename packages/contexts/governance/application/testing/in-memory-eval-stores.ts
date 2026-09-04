// In-memory `CriteriaRepository`, `EvalsRepository` and `GoldenSetsRepository`.
//
// THE TWO UNIQUE CONSTRAINTS ARE REAL HERE. `@@unique([environmentId, name])` on
// a criterion and `@@unique([environmentId, agentId, name])` on a golden set are
// enforced by these doubles, not merely pre-checked by the use case — so a use
// case whose pre-check was removed still fails, which is what makes the
// pre-check's own test non-vacuous.
//
// EVERY READ FILTERS BY ENVIRONMENT. A `findById` for an id that exists in
// another environment answers null, exactly as the port requires, so the
// cross-tenant tests are testing the store's narrowing rather than the absence
// of a seeded row.

import { err, ok, asIdentifier, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  criterionAlreadyExists,
  goldenSetAlreadyExists,
  ledgerUnavailable,
  type ActorId,
  type AdmittedCriterion,
  type AdmittedEval,
  type AdmittedGoldenSet,
  type AgentEval,
  type AgentEvalId,
  type AgentId,
  type EvalAggregateInput,
  type EvalCriterion,
  type EvalCriterionId,
  type GoldenSet,
  type GoldenSetId,
  type RegressionSample,
} from "../../domain/index.js";
import type {
  BaselineSampleQuery,
  CriteriaRepository,
  CriterionPage,
  CriterionQuery,
  EvalPage,
  EvalQuery,
  EvalSampleQuery,
  EvalsRepository,
  GoldenSetPage,
  GoldenSetQuery,
  GoldenSetsRepository,
} from "../ports/index.js";

export class InMemoryCriteriaRepository implements CriteriaRepository {
  private readonly rows: EvalCriterion[] = [];
  private counter = 0;
  private failure: string | null = null;

  constructor(private readonly now: () => Date) {}

  failNext(reason: string): void {
    this.failure = reason;
  }

  size(): number {
    return this.rows.length;
  }

  async create(
    scope: EnvironmentScope,
    criterion: AdmittedCriterion,
    createdBy: ActorId,
    _transaction: TransactionScope,
  ): Promise<Result<EvalCriterion>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const clash = this.rows.find(
      (row) => row.environmentId === scope.environmentId && row.name === criterion.name,
    );
    if (clash !== undefined) return err(criterionAlreadyExists(scope.environmentId, criterion.name));
    this.counter += 1;
    const at = this.now();
    const row: EvalCriterion = {
      ...criterion,
      evalCriterionId: asIdentifier<EvalCriterionId>(`criterion-${String(this.counter).padStart(4, "0")}`),
      environmentId: scope.environmentId,
      isActive: true,
      createdBy,
      createdAt: at,
      updatedAt: at,
    };
    this.rows.push(row);
    return ok(row);
  }

  async update(
    scope: EnvironmentScope,
    criterion: EvalCriterion,
    _transaction: TransactionScope,
  ): Promise<Result<EvalCriterion>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const held = this.rows.find(
      (row) => row.evalCriterionId === criterion.evalCriterionId && row.environmentId === scope.environmentId,
    );
    if (held === undefined) return err(ledgerUnavailable("criterion_not_in_scope"));
    const clash = this.rows.find(
      (row) =>
        row.environmentId === scope.environmentId &&
        row.name === criterion.name &&
        row.evalCriterionId !== criterion.evalCriterionId,
    );
    if (clash !== undefined) return err(criterionAlreadyExists(scope.environmentId, criterion.name));
    this.rows[this.rows.indexOf(held)] = criterion;
    return ok(criterion);
  }

  async remove(
    scope: EnvironmentScope,
    criterionId: EvalCriterionId,
    _transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const held = this.rows.find(
      (row) => row.evalCriterionId === criterionId && row.environmentId === scope.environmentId,
    );
    if (held === undefined) return ok(false);
    this.rows.splice(this.rows.indexOf(held), 1);
    return ok(true);
  }

  async findById(scope: EnvironmentScope, criterionId: EvalCriterionId): Promise<Result<EvalCriterion | null>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(
      this.rows.find(
        (row) => row.evalCriterionId === criterionId && row.environmentId === scope.environmentId,
      ) ?? null,
    );
  }

  async findByName(scope: EnvironmentScope, name: string): Promise<Result<EvalCriterion | null>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(
      this.rows.find((row) => row.environmentId === scope.environmentId && row.name === name) ?? null,
    );
  }

  async page(scope: EnvironmentScope, query: CriterionQuery): Promise<Result<CriterionPage>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const matched = this.rows
      .filter((row) => row.environmentId === scope.environmentId)
      .filter((row) => !query.activeOnly || row.isActive)
      .filter((row) => matchesAgentFilter(row, query))
      .filter(
        (row) =>
          query.search === null || row.name.toLowerCase().includes(query.search.toLowerCase()),
      );
    return ok({ items: matched.slice(query.offset, query.offset + query.limit), total: matched.length });
  }

  async findMany(
    scope: EnvironmentScope,
    criterionIds: readonly EvalCriterionId[],
  ): Promise<Result<readonly EvalCriterion[]>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const wanted = new Set<string>(criterionIds);
    return ok(
      this.rows.filter((row) => row.environmentId === scope.environmentId && wanted.has(row.evalCriterionId)),
    );
  }

  private takeFailure() {
    if (this.failure === null) return null;
    const reason = this.failure;
    this.failure = null;
    return ledgerUnavailable(reason);
  }
}

function matchesAgentFilter(row: EvalCriterion, query: CriterionQuery): boolean {
  if (!("agentId" in query)) return true;
  if (query.agentId === null || query.agentId === undefined) return row.agentId === null;
  return row.agentId === query.agentId || row.agentId === null;
}

export class InMemoryEvalsRepository implements EvalsRepository {
  private readonly rows: AgentEval[] = [];
  private counter = 0;
  private failure: string | null = null;

  constructor(private readonly now: () => Date) {}

  failNext(reason: string): void {
    this.failure = reason;
  }

  size(): number {
    return this.rows.length;
  }

  all(): readonly AgentEval[] {
    return this.rows;
  }

  async append(
    scope: EnvironmentScope,
    admitted: AdmittedEval,
    _transaction: TransactionScope | null,
  ): Promise<Result<AgentEval>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    this.counter += 1;
    const row: AgentEval = {
      agentEvalId: asIdentifier<AgentEvalId>(`eval-${String(this.counter).padStart(4, "0")}`),
      environmentId: scope.environmentId,
      agentId: admitted.agentId,
      agentVersionId: admitted.agentVersionId,
      threadId: admitted.threadId,
      turnId: admitted.turnId,
      criterionId: admitted.criterionId,
      criterionSnapshot: admitted.criterionSnapshot,
      judgeModel: admitted.judgeModel,
      judgePromptUsed: admitted.judgePromptUsed,
      rawResponse: admitted.rawResponse,
      score: admitted.score,
      rationale: admitted.rationale,
      passed: admitted.passed,
      costCents: admitted.costCents,
      latencyMs: admitted.latencyMs,
      createdAt: this.now(),
    };
    this.rows.push(row);
    return ok(row);
  }

  async findById(scope: EnvironmentScope, evalId: AgentEvalId): Promise<Result<AgentEval | null>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(
      this.rows.find((row) => row.agentEvalId === evalId && row.environmentId === scope.environmentId) ?? null,
    );
  }

  async page(scope: EnvironmentScope, query: EvalQuery): Promise<Result<EvalPage>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const matched = this.rows
      .filter((row) => row.environmentId === scope.environmentId)
      .filter((row) => row.createdAt.getTime() >= query.since.getTime())
      .filter((row) => query.agentId === null || row.agentId === query.agentId)
      .filter((row) => query.agentVersionId === null || row.agentVersionId === query.agentVersionId)
      .filter((row) => query.criterionId === null || row.criterionId === query.criterionId)
      .filter((row) => query.threadId === null || row.threadId === query.threadId)
      .filter(
        (row) =>
          query.search === null ||
          (row.rationale ?? "").toLowerCase().includes(query.search.toLowerCase()) ||
          row.judgeModel.toLowerCase().includes(query.search.toLowerCase()),
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return ok({ items: matched.slice(query.offset, query.offset + query.limit), total: matched.length });
  }

  async sample(
    scope: EnvironmentScope,
    query: EvalSampleQuery,
  ): Promise<Result<readonly EvalAggregateInput[]>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const wanted = new Set<string>(query.versionIds);
    return ok(
      this.rows
        .filter((row) => row.environmentId === scope.environmentId)
        .filter((row) => row.agentId === query.agentId)
        .filter((row) => row.createdAt.getTime() >= query.since.getTime())
        .filter((row) => wanted.size === 0 || (row.agentVersionId !== null && wanted.has(row.agentVersionId)))
        .map((row) => ({
          criterionId: row.criterionId,
          agentVersionId: row.agentVersionId,
          score: row.score,
          passed: row.passed,
        })),
    );
  }

  async sampleByIds(
    scope: EnvironmentScope,
    evalIds: readonly AgentEvalId[],
  ): Promise<Result<readonly RegressionSample[]>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const wanted = new Set<string>(evalIds);
    return ok(
      this.rows
        .filter((row) => row.environmentId === scope.environmentId && wanted.has(row.agentEvalId))
        .map((row) => ({ criterionId: row.criterionId, score: row.score })),
    );
  }

  async sampleBaseline(
    scope: EnvironmentScope,
    query: BaselineSampleQuery,
  ): Promise<Result<readonly RegressionSample[]>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(
      this.rows
        .filter((row) => row.environmentId === scope.environmentId)
        .filter((row) => row.agentId === query.agentId)
        .filter((row) => row.agentVersionId === query.agentVersionId)
        .filter((row) => row.createdAt.getTime() >= query.since.getTime())
        .map((row) => ({ criterionId: row.criterionId, score: row.score })),
    );
  }

  private takeFailure() {
    if (this.failure === null) return null;
    const reason = this.failure;
    this.failure = null;
    return ledgerUnavailable(reason);
  }
}

export class InMemoryGoldenSetsRepository implements GoldenSetsRepository {
  private readonly rows: GoldenSet[] = [];
  private counter = 0;
  private failure: string | null = null;

  constructor(private readonly now: () => Date) {}

  failNext(reason: string): void {
    this.failure = reason;
  }

  size(): number {
    return this.rows.length;
  }

  async create(
    scope: EnvironmentScope,
    set: AdmittedGoldenSet,
    createdBy: ActorId,
    _transaction: TransactionScope,
  ): Promise<Result<GoldenSet>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const clash = this.rows.find(
      (row) =>
        row.environmentId === scope.environmentId && row.agentId === set.agentId && row.name === set.name,
    );
    if (clash !== undefined) {
      return err(goldenSetAlreadyExists(scope.environmentId, set.agentId, set.name));
    }
    this.counter += 1;
    const at = this.now();
    const row: GoldenSet = {
      goldenSetId: asIdentifier<GoldenSetId>(`golden-${String(this.counter).padStart(4, "0")}`),
      environmentId: scope.environmentId,
      agentId: set.agentId,
      name: set.name,
      description: set.description,
      threadIds: set.threadIds,
      criterionIds: set.criterionIds,
      createdBy,
      createdAt: at,
      updatedAt: at,
    };
    this.rows.push(row);
    return ok(row);
  }

  async update(
    scope: EnvironmentScope,
    set: GoldenSet,
    _transaction: TransactionScope,
  ): Promise<Result<GoldenSet>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const held = this.rows.find(
      (row) => row.goldenSetId === set.goldenSetId && row.environmentId === scope.environmentId,
    );
    if (held === undefined) return err(ledgerUnavailable("golden_set_not_in_scope"));
    this.rows[this.rows.indexOf(held)] = set;
    return ok(set);
  }

  async remove(
    scope: EnvironmentScope,
    goldenSetId: GoldenSetId,
    _transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const held = this.rows.find(
      (row) => row.goldenSetId === goldenSetId && row.environmentId === scope.environmentId,
    );
    if (held === undefined) return ok(false);
    this.rows.splice(this.rows.indexOf(held), 1);
    return ok(true);
  }

  async findById(scope: EnvironmentScope, goldenSetId: GoldenSetId): Promise<Result<GoldenSet | null>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(
      this.rows.find(
        (row) => row.goldenSetId === goldenSetId && row.environmentId === scope.environmentId,
      ) ?? null,
    );
  }

  async findByName(
    scope: EnvironmentScope,
    agentId: AgentId,
    name: string,
  ): Promise<Result<GoldenSet | null>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(
      this.rows.find(
        (row) =>
          row.environmentId === scope.environmentId && row.agentId === agentId && row.name === name,
      ) ?? null,
    );
  }

  async page(scope: EnvironmentScope, query: GoldenSetQuery): Promise<Result<GoldenSetPage>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const matched = this.rows
      .filter((row) => row.environmentId === scope.environmentId)
      .filter((row) => query.agentId === null || row.agentId === query.agentId);
    return ok({ items: matched.slice(query.offset, query.offset + query.limit), total: matched.length });
  }

  private takeFailure() {
    if (this.failure === null) return null;
    const reason = this.failure;
    this.failure = null;
    return ledgerUnavailable(reason);
  }
}
