// The five `MemoryRepository` methods that read rows this context does NOT own.
//
// ADR M0.3 §5.2 governs MUTATING delegates and exempts reads by name, so these
// five are legal here and would be legal from anywhere; the import ban (§2)
// governs code edges, and there is none — `packages/contexts/memory` knows only
// the five signatures and the branded ids they take, and this file knows the
// tables. Both port headers say so in as many words.
//
// THEY ARE IN THEIR OWN MODULE BECAUSE THE ROWS ARE SOMEBODY ELSE'S. `Agent`,
// `AgentBinding` and `AgentCluster` belong to `agents` (§1 row 5), `Thread` and
// `Turn` to `conversations` (row 16), `MessageRating` to `governance` (row 14).
// A reader of `memory-store.ts` should be able to take it for granted that every
// statement in that file is on a row this context is the sole writer of, and the
// only way to make that true is for the ones that are not to live here.
//
// THE ORDERS ARE TOTAL AND THE STORE CHOOSES THEM. `listAgentBindings` feeds
// `resolveWriteBinding`, whose last branch accepts a single binding and refuses
// several — so the LIST is what decides a write's attribution, and an unordered
// list would make two identical environments answer differently. `agentId` is
// unique per environment (`@@unique([environmentId, agentId])`), so ordering by
// it is total by construction.
//
// EVERY READ IS SCOPED, AND THE SCOPE IS IN THE STATEMENT. `findSourceThreadOwnership`
// takes an environment and a thread id and sends BOTH: a thread id is
// installation-wide, and the port's own comment ("null when the thread is not in
// this environment") is a promise the `WHERE` has to keep rather than a comment
// the caller has to trust.

import type {
  AgentBinding,
  AgentId,
  ClusterId,
  EndUserId,
  EnvironmentScope,
  MemoryOwnership,
  RatingRevision,
  Result,
  ThreadId,
  TurnId,
  TurnRating,
} from "@platos/context-memory/application/ports/index.js";
import { asMemoryIdentifier, ok } from "@platos/context-memory/application/ports/index.js";

import { requireUuid, requireUuidList } from "./memory-guards.js";
import { refuseMemory } from "./memory-refusal.js";
import { readEnvironmentScope } from "./memory-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** The two columns of `AgentBinding` this context reads, and nothing else. */
const BINDING_COLUMNS = { agentId: true, clusterId: true } as const;

/** The three columns of `Thread` a memory's attribution is taken from. */
const THREAD_COLUMNS = { agentId: true, clusterId: true, endUserId: true } as const;

/** One `MessageRating` and its two tenant ancestors, flattened by the JOIN. */
interface RatingAncestryRow {
  readonly endUserId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly environmentId: string;
  readonly projectId: string;
  readonly organizationId: string;
}

export interface MemoryPlacementReads {
  listAgentBindings(environment: EnvironmentScope): Promise<Result<readonly AgentBinding[]>>;
  findSourceThreadOwnership(
    environment: EnvironmentScope,
    threadId: ThreadId,
  ): Promise<Result<{ readonly ownership: MemoryOwnership; readonly endUserId: EndUserId } | null>>;
  countTurnsInThread(threadId: ThreadId, turnIds: readonly TurnId[]): Promise<Result<number>>;
  findRatingRevision(ratingId: string): Promise<Result<RatingRevision | null>>;
  listRatingsForTurns(
    environment: EnvironmentScope,
    endUserId: EndUserId,
    turnIds: readonly TurnId[],
  ): Promise<Result<readonly TurnRating[]>>;
}

export function createMemoryPlacementReads(
  transactions: TenancyTransactions,
): MemoryPlacementReads {
  return {
    async listAgentBindings(environment: EnvironmentScope): Promise<Result<readonly AgentBinding[]>> {
      return refuseMemory(async () => {
        requireUuid("environmentId", environment.environmentId);
        const rows = await transactions.reader().agentBinding.findMany({
          where: { environmentId: environment.environmentId },
          select: BINDING_COLUMNS,
          orderBy: { agentId: "asc" },
        });
        return ok(
          rows.map((row) => ({
            agentId: asMemoryIdentifier<AgentId>(row.agentId),
            clusterId: row.clusterId === null ? null : asMemoryIdentifier<ClusterId>(row.clusterId),
          })),
        );
      }, "memory listAgentBindings");
    },

    async findSourceThreadOwnership(
      environment: EnvironmentScope,
      threadId: ThreadId,
    ): Promise<Result<{ readonly ownership: MemoryOwnership; readonly endUserId: EndUserId } | null>> {
      return refuseMemory(async () => {
        requireUuid("environmentId", environment.environmentId);
        requireUuid("sourceThreadId", threadId);
        const row = await transactions.reader().thread.findFirst({
          where: { id: threadId, environmentId: environment.environmentId },
          select: THREAD_COLUMNS,
        });
        if (row === null) return ok(null);
        return ok({
          ownership: {
            agentId: asMemoryIdentifier<AgentId>(row.agentId),
            clusterId: row.clusterId === null ? null : asMemoryIdentifier<ClusterId>(row.clusterId),
          },
          endUserId: asMemoryIdentifier<EndUserId>(row.endUserId),
        });
      }, "memory findSourceThreadOwnership");
    },

    /**
     * How many of those turns are in that thread.
     *
     * A COUNT rather than a set difference, because that is what the port asks
     * for and what `extract-from-conversation.ts` compares against the length of
     * the list it sent. It counts ROWS, so a caller that passed the same turn id
     * twice gets one — which is the answer the `IN` list means and the answer
     * `Memory_extraction_provenance_check` will later be measured against, since
     * `admitProvenance` de-duplicates before a row is ever built.
     */
    async countTurnsInThread(threadId: ThreadId, turnIds: readonly TurnId[]): Promise<Result<number>> {
      return refuseMemory(async () => {
        requireUuid("sourceThreadId", threadId);
        requireUuidList("sourceTurnIds", turnIds);
        const count = await transactions.reader().turn.count({
          where: { threadId, id: { in: [...turnIds] } },
        });
        return ok(count);
      }, "memory countTurnsInThread");
    },

    /**
     * One rating's identity and revision.
     *
     * `MessageRating` carries `environmentId` and nothing above it, and
     * `RatingRevision` carries a whole `EnvironmentScope` — so the project and
     * the organization have to come from somewhere, and the caller supplies no
     * scope to take them from.
     *
     * *** IT IS RAW SQL BECAUSE A NESTED `select` IS THREE STATEMENTS. *** That
     * was MEASURED, not assumed: the obvious implementation is
     * `messageRating.findUnique` with `environment: { select: { projectId,
     * project: { select: { organizationId } } } }`, which reads as one query and
     * which `memory-statements.integration.test.ts` counted at THREE — Prisma
     * loads each relation level with its own round trip unless the `relationJoins`
     * preview feature is on, and it is not. That is an N+1 in the TENANT TREE
     * rather than in the rows, so it would never have grown with the data and
     * would never have shown up in a load test; the pin is the only thing that
     * could have found it. The JOIN below is one statement, and it is a READ, so
     * ADR M0.3 §5.2 exempts it by name exactly as it exempts a `findUnique`.
     */
    async findRatingRevision(ratingId: string): Promise<Result<RatingRevision | null>> {
      return refuseMemory(async () => {
        requireUuid("ratingId", ratingId);
        const rows = await transactions.reader().$queryRaw<readonly RatingAncestryRow[]>`
          SELECT rating."endUserId", rating."turnId", rating."revision",
                 rating."environmentId", environment."projectId",
                 project."organizationId"
            FROM "MessageRating" rating
            JOIN "Environment" environment ON environment."id" = rating."environmentId"
            JOIN "Project" project ON project."id" = environment."projectId"
           WHERE rating."id" = ${ratingId}::uuid`;
        const row = rows[0];
        if (row === undefined) return ok(null);
        return ok({
          environment: readEnvironmentScope(row.environmentId, {
            projectId: row.projectId,
            project: { organizationId: row.organizationId },
          }),
          endUserId: asMemoryIdentifier<EndUserId>(row.endUserId),
          turnId: asMemoryIdentifier<TurnId>(row.turnId),
          revision: row.revision,
        });
      }, "memory findRatingRevision");
    },

    async listRatingsForTurns(
      environment: EnvironmentScope,
      endUserId: EndUserId,
      turnIds: readonly TurnId[],
    ): Promise<Result<readonly TurnRating[]>> {
      return refuseMemory(async () => {
        requireUuid("environmentId", environment.environmentId);
        requireUuid("endUserId", endUserId);
        requireUuidList("sourceTurnIds", turnIds);
        const rows = await transactions.reader().messageRating.findMany({
          where: {
            environmentId: environment.environmentId,
            endUserId,
            turnId: { in: [...turnIds] },
          },
          select: { turnId: true, rating: true },
          orderBy: { turnId: "asc" },
        });
        return ok(
          rows.map((row) => ({ turnId: asMemoryIdentifier<TurnId>(row.turnId), rating: row.rating })),
        );
      }, "memory listRatingsForTurns");
    },
  };
}
