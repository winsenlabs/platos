// An in-memory `GoldenSetsRepository`.
//
// Split out of `in-memory-eval-stores.ts` when that file crossed the ADR M0.3 §6
// 400-line warning band. The seam is the coupling: a criterion and an eval are
// tied together by `AgentEval.criterion @relation(onDelete: Cascade)`, and a
// golden set is tied to neither — it names thread ids and criterion ids as plain
// string arrays, exactly as the canonical model stores them.
//
// `@@unique([environmentId, agentId, name])` IS ENFORCED HERE, not merely
// pre-checked by the use case, so a use case whose pre-check was removed still
// fails. The name is scoped to the AGENT, so two agents may each have a set
// called "regression"; a double that scoped it to the environment would make
// that a passing test for the wrong reason.

import { err, ok, asIdentifier, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  goldenSetAlreadyExists,
  ledgerUnavailable,
  type ActorId,
  type AdmittedGoldenSet,
  type AgentId,
  type GoldenSet,
  type GoldenSetId,
} from "../../domain/index.js";
import type { GoldenSetPage, GoldenSetQuery, GoldenSetsRepository } from "../ports/index.js";

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
