// The `GoldenSetsRepository` — `governance`'s `GoldenSet` half.
//
// THE NAME IS UNIQUE PER AGENT, NOT PER ENVIRONMENT.
// `@@unique([environmentId, agentId, name])`, so two agents may each have a set
// called "regression", and `findByName` takes all three. `create` maps the index
// to `GOVERNANCE_GOLDEN_SET_ALREADY_EXISTS` through a non-raising insert, for the
// reason `governance-criteria.ts` gives: a raised constraint would take the
// caller's transaction away along with the answer.
//
// *** `update` CHECKS THE NAME AND THE DOUBLE DOES NOT — A REPORTED GAP ***
// `InMemoryGoldenSetsRepository.update` locates the row by id and replaces it,
// with NO uniqueness check at all. So a rename onto a name that agent already
// uses succeeds against the double, leaving two rows the canonical index forbids,
// and is refused by PostgreSQL. This store therefore has a statement the double
// has no counterpart for, the divergence is pinned as a named case in
// `governance-constraints.integration.test.ts`, and the shared conformance
// scenario deliberately does not rename onto a taken name — a scenario is for
// comparing answers, and this is a place where the double's answer is wrong
// rather than different.
//
// `threadIds` AND `criterionIds` ARE `String[]`, NOT `uuid[]`, and that is why
// there is no uuid guard on them. The canonical model stores them as text
// arrays with no element constraint and no foreign key: a golden set names
// conversations that may since have been deleted, and a set that could not name
// a departed thread would silently shrink its own sample.

import type {
  ActorId,
  AdmittedGoldenSet,
  AgentId,
  EnvironmentScope,
  GoldenSet,
  GoldenSetId,
  GoldenSetPage,
  GoldenSetQuery,
  GoldenSetsRepository,
  Result,
  TransactionScope,
} from "@platos/context-governance/application/ports/index.js";
import {
  err,
  goldenSetAlreadyExists,
  ledgerUnavailable,
  ok,
} from "@platos/context-governance/application/ports/index.js";

import { requireUuid } from "./governance-guards.js";
import { refuse } from "./governance-refusal.js";
import {
  readGoldenSet,
  scopedWhere,
  writeGoldenSet,
  type GoldenSetRow,
} from "./governance-rows.js";
import type { TenancyTransactions } from "./transaction.js";

const GOLDEN_SET_COLUMNS = {
  id: true,
  environmentId: true,
  agentId: true,
  name: true,
  description: true,
  threadIds: true,
  criterionIds: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function createGoldenSetsRepository(
  transactions: TenancyTransactions,
  now: () => Date,
): GoldenSetsRepository {
  return {
    async create(
      scope: EnvironmentScope,
      set: AdmittedGoldenSet,
      createdBy: ActorId,
      transaction: TransactionScope,
    ): Promise<Result<GoldenSet>> {
      return refuse(async () => {
        requireUuid("GoldenSet.agentId", set.agentId);
        const client = transactions.writer(transaction);
        const at = now();
        const created = await client.goldenSet.createManyAndReturn({
          data: [{ ...writeGoldenSet(scope, set, createdBy), createdAt: at, updatedAt: at }],
          skipDuplicates: true,
          select: GOLDEN_SET_COLUMNS,
        });
        const row = created[0];
        if (row === undefined) {
          return err(goldenSetAlreadyExists(scope.environmentId, set.agentId, set.name));
        }
        return ok(readGoldenSet(row as GoldenSetRow));
      }, "goldenSets create");
    },

    async update(
      scope: EnvironmentScope,
      set: GoldenSet,
      transaction: TransactionScope,
    ): Promise<Result<GoldenSet>> {
      return refuse(async () => {
        requireUuid("GoldenSet.id", set.goldenSetId);
        requireUuid("GoldenSet.agentId", set.agentId);
        const client = transactions.writer(transaction);
        const held = await client.goldenSet.findFirst({
          where: { id: set.goldenSetId, ...scopedWhere(scope) },
          select: { id: true },
        });
        if (held === null) return err(ledgerUnavailable("golden_set_not_in_scope"));
        const clash = await client.goldenSet.findFirst({
          where: {
            ...scopedWhere(scope),
            agentId: set.agentId,
            name: set.name,
            id: { not: set.goldenSetId },
          },
          select: { id: true },
        });
        if (clash !== null) {
          return err(goldenSetAlreadyExists(scope.environmentId, set.agentId, set.name));
        }
        const outcome = await client.goldenSet.updateMany({
          where: { id: set.goldenSetId, ...scopedWhere(scope) },
          data: {
            agentId: set.agentId,
            name: set.name,
            description: set.description,
            threadIds: [...set.threadIds],
            criterionIds: [...set.criterionIds],
            updatedAt: set.updatedAt,
          },
        });
        if (outcome.count === 0) return err(ledgerUnavailable("golden_set_not_in_scope"));
        return ok(set);
      }, "goldenSets update");
    },

    async remove(
      scope: EnvironmentScope,
      goldenSetId: GoldenSetId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      return refuse(async () => {
        const client = transactions.writer(transaction);
        const outcome = await client.goldenSet.deleteMany({
          where: { id: goldenSetId, ...scopedWhere(scope) },
        });
        return ok(outcome.count > 0);
      }, "goldenSets remove");
    },

    async findById(
      scope: EnvironmentScope,
      goldenSetId: GoldenSetId,
    ): Promise<Result<GoldenSet | null>> {
      return refuse(async () => {
        const row = await transactions.reader().goldenSet.findFirst({
          where: { id: goldenSetId, ...scopedWhere(scope) },
          select: GOLDEN_SET_COLUMNS,
        });
        return ok(row === null ? null : readGoldenSet(row as GoldenSetRow));
      }, "goldenSets findById");
    },

    async findByName(
      scope: EnvironmentScope,
      agentId: AgentId,
      name: string,
    ): Promise<Result<GoldenSet | null>> {
      return refuse(async () => {
        const row = await transactions.reader().goldenSet.findFirst({
          where: { agentId, name, ...scopedWhere(scope) },
          select: GOLDEN_SET_COLUMNS,
        });
        return ok(row === null ? null : readGoldenSet(row as GoldenSetRow));
      }, "goldenSets findByName");
    },

    async page(scope: EnvironmentScope, query: GoldenSetQuery): Promise<Result<GoldenSetPage>> {
      return refuse(async () => {
        const where = {
          ...scopedWhere(scope),
          ...(query.agentId === null ? {} : { agentId: query.agentId }),
        };
        const reader = transactions.reader();
        const rows = await reader.goldenSet.findMany({
          where,
          select: GOLDEN_SET_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          skip: query.offset,
          take: query.limit,
        });
        const total = await reader.goldenSet.count({ where });
        return ok({ items: rows.map((row) => readGoldenSet(row as GoldenSetRow)), total });
      }, "goldenSets page");
    },
  };
}
