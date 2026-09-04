// The `GoldenSetsRepository` port — the GoldenSet table, seen as an interface.
//
// ADR M0.3 §1 row 14 makes this context the SOLE WRITER of `GoldenSet`.
//
// `@@unique([environmentId, agentId, name])` scopes the name to the AGENT, not
// to the environment, so two agents may each have a set called "regression". The
// pre-check therefore takes all three, and an implementation MUST map the
// constraint violation to `GOVERNANCE_GOLDEN_SET_ALREADY_EXISTS` rather than
// letting a store exception escape.

import type { EnvironmentScope, Result, TransactionScope } from "@platos/kernel";

import type { ActorId, AdmittedGoldenSet, AgentId, GoldenSet, GoldenSetId } from "../../domain/index.js";

export interface GoldenSetQuery {
  readonly limit: number;
  readonly offset: number;
  readonly agentId: AgentId | null;
}

export interface GoldenSetPage {
  readonly items: readonly GoldenSet[];
  readonly total: number;
}

export interface GoldenSetsRepository {
  create(
    scope: EnvironmentScope,
    set: AdmittedGoldenSet,
    createdBy: ActorId,
    transaction: TransactionScope,
  ): Promise<Result<GoldenSet>>;

  update(scope: EnvironmentScope, set: GoldenSet, transaction: TransactionScope): Promise<Result<GoldenSet>>;

  remove(
    scope: EnvironmentScope,
    goldenSetId: GoldenSetId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  findById(scope: EnvironmentScope, goldenSetId: GoldenSetId): Promise<Result<GoldenSet | null>>;

  findByName(scope: EnvironmentScope, agentId: AgentId, name: string): Promise<Result<GoldenSet | null>>;

  page(scope: EnvironmentScope, query: GoldenSetQuery): Promise<Result<GoldenSetPage>>;
}
