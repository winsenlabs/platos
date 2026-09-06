// The `CriteriaRepository` — `governance`'s `EvalCriterion` half.
//
// THE UNIQUE INDEX IS MAPPED TO A CODE, NOT LET RAISE. The port says so: "An
// implementation MUST map the constraint violation to
// `GOVERNANCE_CRITERION_ALREADY_EXISTS` rather than letting a store exception
// escape." `create` therefore goes through `createManyAndReturn` with
// `skipDuplicates`, which is `ON CONFLICT DO NOTHING` and raises nothing at all —
// so the caller keeps a usable transaction, which a raised constraint would have
// taken away along with the answer.
//
// A COUNT OF ZERO MEANS THE NAME, AND NOTHING ELSE. `EvalCriterion` carries two
// unique indexes — its primary key and `(environmentId, name)` — and the primary
// key is minted by the DATABASE's own `@default(uuid())`, so it cannot be the
// one that refused. That is why this file needs no follow-up read to say which
// index spoke, where `cost-budgets.ts` did.
//
// `update` IS THREE STATEMENTS AND THE ORDER IS THE CONTRACT. Scope first, name
// second, write third — the same order `InMemoryCriteriaRepository` checks in,
// so a criterion that is both out of scope AND name-clashing reports the same
// refusal from both stores. It is not one `updateMany`: an update that moved the
// name onto a taken one would raise the unique index and abort the transaction,
// which is the failure this whole file is arranged to avoid.
//
// `remove` DESTROYS EVERY EVAL TAKEN AGAINST THE CRITERION, and this file does
// not do it — `AgentEval.criterion @relation(onDelete: Cascade)` does. The port
// states the consequence so no adapter is written believing `criterionSnapshot`
// survives a DELETE; the single statement below is what makes it the database's
// decision rather than this package's.

import type {
  ActorId,
  AdmittedCriterion,
  CriteriaRepository,
  CriterionPage,
  CriterionQuery,
  EnvironmentScope,
  EvalCriterion,
  EvalCriterionId,
  Result,
  TransactionScope,
} from "@platos/context-governance/application/ports/index.js";
import {
  criterionAlreadyExists,
  err,
  ledgerUnavailable,
  ok,
} from "@platos/context-governance/application/ports/index.js";

import { requireStorableScale, requireUuid } from "./governance-guards.js";
import { refuse } from "./governance-refusal.js";
import { readCriterion, scopedWhere, type EvalCriterionRow } from "./governance-rows.js";
import type { TenancyTransactions } from "./transaction.js";

const CRITERION_COLUMNS = {
  id: true,
  environmentId: true,
  agentId: true,
  name: true,
  description: true,
  judgePrompt: true,
  rubric: true,
  judgeModel: true,
  scoreScaleMin: true,
  scoreScaleMax: true,
  isActive: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The listing's agent filter, which is a MEMBERSHIP rather than an equality.
 *
 * `undefined` does not filter. `null` matches only the SHARED criteria. A
 * concrete id matches that agent's criteria PLUS the shared ones, because
 * `domain/criterion.ts` says a shared criterion that stopped appearing for one
 * agent would silently stop being scored. `"agentId" in query` is what
 * distinguishes an absent key from an explicit null; a destructured default
 * would collapse the two and quietly widen the listing.
 */
function agentFilter(query: CriterionQuery): Record<string, unknown> {
  if (!("agentId" in query)) return {};
  if (query.agentId === null || query.agentId === undefined) return { agentId: null };
  return { OR: [{ agentId: query.agentId }, { agentId: null }] };
}

export function createCriteriaRepository(
  transactions: TenancyTransactions,
  now: () => Date,
): CriteriaRepository {
  return {
    async create(
      scope: EnvironmentScope,
      criterion: AdmittedCriterion,
      createdBy: ActorId,
      transaction: TransactionScope,
    ): Promise<Result<EvalCriterion>> {
      return refuse(async () => {
        requireUuid("EvalCriterion.agentId", criterion.agentId);
        requireStorableScale(criterion.scoreScaleMin, criterion.scoreScaleMax);
        const client = transactions.writer(transaction);
        const at = now();
        const created = await client.evalCriterion.createManyAndReturn({
          data: [
            {
              environmentId: scope.environmentId,
              agentId: criterion.agentId,
              name: criterion.name,
              description: criterion.description,
              judgePrompt: criterion.judgePrompt,
              rubric: criterion.rubric,
              judgeModel: criterion.judgeModel,
              scoreScaleMin: criterion.scoreScaleMin,
              scoreScaleMax: criterion.scoreScaleMax,
              isActive: true,
              createdBy,
              createdAt: at,
              updatedAt: at,
            },
          ],
          skipDuplicates: true,
          select: CRITERION_COLUMNS,
        });
        const row = created[0];
        if (row === undefined) {
          return err(criterionAlreadyExists(scope.environmentId, criterion.name));
        }
        return ok(readCriterion(row as EvalCriterionRow));
      }, "criteria create");
    },

    async update(
      scope: EnvironmentScope,
      criterion: EvalCriterion,
      transaction: TransactionScope,
    ): Promise<Result<EvalCriterion>> {
      return refuse(async () => {
        requireUuid("EvalCriterion.id", criterion.evalCriterionId);
        requireUuid("EvalCriterion.agentId", criterion.agentId);
        requireStorableScale(criterion.scoreScaleMin, criterion.scoreScaleMax);
        const client = transactions.writer(transaction);
        const held = await client.evalCriterion.findFirst({
          where: { id: criterion.evalCriterionId, ...scopedWhere(scope) },
          select: { id: true },
        });
        if (held === null) return err(ledgerUnavailable("criterion_not_in_scope"));
        const clash = await client.evalCriterion.findFirst({
          where: {
            ...scopedWhere(scope),
            name: criterion.name,
            id: { not: criterion.evalCriterionId },
          },
          select: { id: true },
        });
        if (clash !== null) return err(criterionAlreadyExists(scope.environmentId, criterion.name));
        // Keyed on BOTH id AND environmentId even though the row was just read
        // in scope: the read and the write are two statements, and a key that
        // was narrow only in the first would let a concurrently-moved row be
        // written by the second.
        const outcome = await client.evalCriterion.updateMany({
          where: { id: criterion.evalCriterionId, ...scopedWhere(scope) },
          data: {
            agentId: criterion.agentId,
            name: criterion.name,
            description: criterion.description,
            judgePrompt: criterion.judgePrompt,
            rubric: criterion.rubric,
            judgeModel: criterion.judgeModel,
            scoreScaleMin: criterion.scoreScaleMin,
            scoreScaleMax: criterion.scoreScaleMax,
            isActive: criterion.isActive,
            updatedAt: criterion.updatedAt,
          },
        });
        if (outcome.count === 0) return err(ledgerUnavailable("criterion_not_in_scope"));
        return ok(criterion);
      }, "criteria update");
    },

    async remove(
      scope: EnvironmentScope,
      criterionId: EvalCriterionId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      return refuse(async () => {
        const client = transactions.writer(transaction);
        const outcome = await client.evalCriterion.deleteMany({
          where: { id: criterionId, ...scopedWhere(scope) },
        });
        return ok(outcome.count > 0);
      }, "criteria remove");
    },

    async findById(
      scope: EnvironmentScope,
      criterionId: EvalCriterionId,
    ): Promise<Result<EvalCriterion | null>> {
      return refuse(async () => {
        const row = await transactions.reader().evalCriterion.findFirst({
          where: { id: criterionId, ...scopedWhere(scope) },
          select: CRITERION_COLUMNS,
        });
        return ok(row === null ? null : readCriterion(row as EvalCriterionRow));
      }, "criteria findById");
    },

    async findByName(scope: EnvironmentScope, name: string): Promise<Result<EvalCriterion | null>> {
      return refuse(async () => {
        // EXACT, not case-folded, because the port says so and because the
        // unique index it pre-checks is itself exact: a case-insensitive
        // pre-check would answer "taken" for a name `create` would then accept.
        const row = await transactions.reader().evalCriterion.findFirst({
          where: { name, ...scopedWhere(scope) },
          select: CRITERION_COLUMNS,
        });
        return ok(row === null ? null : readCriterion(row as EvalCriterionRow));
      }, "criteria findByName");
    },

    async page(scope: EnvironmentScope, query: CriterionQuery): Promise<Result<CriterionPage>> {
      return refuse(async () => {
        const where = {
          ...scopedWhere(scope),
          ...(query.activeOnly ? { isActive: true } : {}),
          ...agentFilter(query),
          ...(query.search === null
            ? {}
            : { name: { contains: query.search, mode: "insensitive" as const } }),
        };
        const reader = transactions.reader();
        const rows = await reader.evalCriterion.findMany({
          where,
          select: CRITERION_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          skip: query.offset,
          take: query.limit,
        });
        const total = await reader.evalCriterion.count({ where });
        return ok({ items: rows.map((row) => readCriterion(row as EvalCriterionRow)), total });
      }, "criteria page");
    },

    async findMany(
      scope: EnvironmentScope,
      criterionIds: readonly EvalCriterionId[],
    ): Promise<Result<readonly EvalCriterion[]>> {
      return refuse(async () => {
        // ONE statement for the whole list, and the empty list is answered
        // WITHOUT one. A rollup resolves its labels here, so a loop of
        // `findById` would be the N+1 this port exists to prevent.
        if (criterionIds.length === 0) return ok([]);
        const rows = await transactions.reader().evalCriterion.findMany({
          where: { id: { in: [...criterionIds] }, ...scopedWhere(scope) },
          select: CRITERION_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return ok(rows.map((row) => readCriterion(row as EvalCriterionRow)));
      }, "criteria findMany");
    },
  };
}
