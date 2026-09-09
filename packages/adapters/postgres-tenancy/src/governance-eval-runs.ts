// `governance`'s `EvalRunQueue` — the durable hand-over of a planned run.
//
// ---------------------------------------------------------------------------
// THE OBJECTION THIS FILE ANSWERS, WHICH WAS WRITTEN IN THIS DIRECTORY
//
// `governance-repository.ts` said outright why this port was NOT satisfied here:
// "its own error constructor -- `queueUnavailable`, deliberately distinct from
// `ledgerUnavailable` -- exists so 'the dispatcher refused the work' and 'a table
// is down' stay separable. Satisfying it from the canonical store would merge
// exactly those two incidents."
//
// THE PREMISE IS FALSE, AND IT IS FALSE IN A WAY A TEST CAN SHOW. What mints
// `ledgerUnavailable` is not this DIRECTORY; it is `governance-refusal.ts`'s
// `refuse`, one helper that five store modules happen to share. This module does
// not use it. `refuseQueue` below catches the same three kinds of throw and
// mints `queueUnavailable`, so a single induced outage answers
// `GOVERNANCE_QUEUE_UNAVAILABLE` on this port and
// `GOVERNANCE_LEDGER_UNAVAILABLE` on `evals.append` IN THE SAME PROCESS AGAINST
// THE SAME DATABASE -- which is what "separable" has to mean if it means
// anything, and is pinned in `governance-eval-runs.integration.test.ts`.
//
// The half of the objection that IS true is stated rather than hidden: when the
// one PostgreSQL database is unreachable, both ports fail together, because both
// are behind one client. That is a property of ADR M0.3 §15's consolidation and
// it is already true of every other pair of ports in this directory. It is not
// what the two error codes are for; the codes are what tells an operator which
// SEAM refused, and they stay distinct.
//
// WHY THE ROW IS HERE AT ALL. §15 gives the one PostgreSQL database one client
// and one adapter directory, which is the same sentence that put `governance`'s
// five existing stores here. `packages/adapters/durable-runtime` is a generated
// placeholder whose configuration section anchors an EXTERNAL service
// (`PLATOS_DURABLE_RUNTIME_API_URL` and a secret key), so implementing the
// kernel `DurableRuntime` over this database would decide a supplier question
// that ADR M0.3 §7 decision 10 has already answered differently. Recording a ROW
// is not that decision: §15 says where rows go, and this is the same
// transactional hand-over shape the tree already uses for `Event`, where the
// `outbox` adapter decides what an event is and this directory issues the
// INSERT. The port's own header says "the day the runtime changes, one adapter
// changes", and this is the adapter it means.
//
// ---------------------------------------------------------------------------
// THE PLAN IS TWO PARALLEL TEXT ARRAYS, NOT JSON, AND THAT IS FORCED. The
// `00000000000000_initial` migration is hash-pinned and `schema.test.ts` demands
// a `<Model>_<column>_json_root` CHECK in THAT file for every `Json` field, so a
// post-initial table cannot carry one. `GoldenSet` already stores its two lists
// as TEXT arrays, and a plan is those two paired BY INDEX in plan order; the
// migration's `EvalRun_pairs_check` refuses a row where the arrays differ in
// length or disagree with `pairCount`, which is a stronger statement than a root
// check would have been.
//
// ---------------------------------------------------------------------------
// THE DIGEST, WHICH IS THE ONE THING THIS FILE COULD NOT HAVE GOT AWAY WITHOUT
//
// `enqueue-eval-run.ts` builds the key over the set id, EVERY PAIR IN PLAN ORDER
// and the baseline, and `DEFAULT_GOVERNANCE_POLICY.goldenSets` caps a set at
// five hundred pairs. At that ceiling the key is roughly 37 kB. The port
// anticipates the consequence: the key "is a plain joined string rather than a
// digest because this context owns no hashing port ... the adapter behind
// `EvalRunQueue` may digest it".
//
// WHAT THE LIMIT ACTUALLY IS, MEASURED RATHER THAN REMEMBERED. This paragraph
// first said "a btree index row may not exceed about 2704 bytes, so a unique
// index over the key itself refuses the insert". Against a real PostgreSQL 16
// that is wrong twice, and `governance-eval-runs.integration.test.ts` exhibits
// both:
//
//   * a unique index over the key ACCEPTS a 37 kB key, because an index datum
//     is COMPRESSED before it is measured and this key repeats one thread id
//     twenty-five times over in any real set;
//   * the refusal, when it comes, is the index-tuple limit and not the btree
//     "version 4 maximum" -- `index row requires 19440 bytes, maximum size is
//     8191`, SQLSTATE 54000 -- and it comes only for a key that does not
//     compress.
//
// So the failure is reached by ENTROPY and not by length, which is worse than
// the rule first written down: an install would meet it on some golden sets and
// not others, with nothing at the port or in the schema to say which. A 64-hex
// digest is the same size for every key, so the unique index is over the digest
// and the key is kept beside it, unindexed. BOTH, not either: a digest alone
// cannot tell a repeated request from a collision, and this store refuses a
// collision rather than answering `alreadyQueued` for a run that is not the
// same run.
//
// ---------------------------------------------------------------------------
// THE CONSUMER HALF IS NOT ON THE PORT, AND IS HERE ANYWAY
//
// `EvalRunQueue` declares `enqueue` and nothing else, which is right: what
// `governance` needs is to hand work over. But a queue nothing can take work OUT
// of is not durable, it is merely written down, and the properties that make a
// queue correct are all on the consumer side. `claim`, `acknowledge` and
// `abandon` are published as this adapter's own surface, satisfied by the same
// connection, and they are what the dispatcher of the next milestone binds to.
// `claim` is `FOR UPDATE SKIP LOCKED` under a LEASE, so a consumer that dies
// between claiming and acknowledging loses the lease and the run becomes
// claimable again -- at-least-once, never at-most-once.

import { createHash } from "node:crypto";

import type {
  EnqueuedEvalRun,
  EnvironmentScope,
  EvalPair,
  EvalRunId,
  EvalRunQueue,
  EvalRunRequest,
  Result,
} from "@platos/context-governance/application/ports/index.js";
import {
  asGovernanceIdentifier,
  err,
  ok,
  queueUnavailable,
} from "@platos/context-governance/application/ports/index.js";

import { GovernanceWriteRefused, requireUuid } from "./governance-guards.js";
import { UnreadableRowError } from "./mapping.js";
import type { TenancyTransactions } from "./transaction.js";

/** The key arrived empty. Two identical requests must share a key, and "" is not one. */
export const EVAL_RUN_KEY_EMPTY = "governance.write.eval_run_key_empty";

/** Two different keys hashed alike. Never seen; refused rather than merged. */
export const EVAL_RUN_DIGEST_COLLISION = "governance.write.eval_run_digest_collision";

/** A claim asked for a lease that cannot bound anything. */
export const EVAL_RUN_LEASE_INVALID = "governance.write.eval_run_lease_invalid";

/** Stored plan arrays this binary cannot read back as a plan. */
export const UNREADABLE_EVAL_RUN_PAIRS = "governance.row.unreadable_eval_run_pairs";

/** One run a dispatcher now holds the lease on. */
export interface ClaimedEvalRun {
  readonly runId: EvalRunId;
  readonly environmentId: string;
  readonly goldenSetId: string;
  readonly agentId: string;
  readonly baselineVersionId: string | null;
  readonly pairs: readonly EvalPair[];
  readonly pairCount: number;
  /** How many times this run has been handed out, including this one. */
  readonly deliveries: number;
  readonly leaseExpiresAt: Date;
}

/**
 * The consumer's half. NOT on `EvalRunQueue`, and published here on purpose.
 *
 * Naming it as an interface rather than leaving three loose methods is what lets
 * the dispatcher of the next milestone depend on a shape instead of on this
 * package, the day the two are separated.
 */
export interface EvalRunDispatch {
  /**
   * Take up to `limit` runs, each under a lease of `leaseMs`.
   *
   * A run is claimable when it is `QUEUED`, or when it is `RUNNING` and its
   * lease has expired — which is the only reason a crashed consumer's work comes
   * back. `SKIP LOCKED` is what makes two consumers running this statement at
   * the same instant take DISJOINT sets rather than one of them waiting.
   */
  claim(owner: string, leaseMs: number, limit: number): Promise<Result<readonly ClaimedEvalRun[]>>;
  /** Finish a run this owner holds. False when the lease moved on. */
  acknowledge(runId: EvalRunId, owner: string): Promise<Result<boolean>>;
  /** Give a run back for another delivery. False when the lease moved on. */
  abandon(runId: EvalRunId, owner: string, reason: string): Promise<Result<boolean>>;
}

export type EvalRunStore = EvalRunQueue & EvalRunDispatch;

interface EvalRunRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly pairCount: number;
}

interface ClaimedRow {
  readonly id: string;
  readonly environmentId: string;
  readonly goldenSetId: string;
  readonly agentId: string;
  readonly baselineVersionId: string | null;
  readonly pairThreadIds: readonly string[];
  readonly pairCriterionIds: readonly string[];
  readonly pairCount: number;
  readonly deliveries: number;
  readonly leaseExpiresAt: Date;
}

/** The unique column. SHA-256 hex, 64 characters, whatever the key's length. */
export function evalRunDigest(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
}

/**
 * Turn a throw into a `Result` carrying THE QUEUE'S code.
 *
 * A near-copy of `governance-refusal.ts`'s `refuse` and deliberately not a call
 * to it: the whole point of this seam is that its refusals are
 * `GOVERNANCE_QUEUE_UNAVAILABLE`. `TransactionScopeError` is rethrown for the
 * reason that file gives — a write that lost its transaction is a defect in the
 * composition, not a busy store.
 */
async function refuseQueue<Value>(
  work: () => Promise<Result<Value>>,
  label: string,
): Promise<Result<Value>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GovernanceWriteRefused) return err(queueUnavailable(`${error.code}: ${error.detail}`));
    if (error instanceof UnreadableRowError) {
      return err(queueUnavailable(`${error.code}: ${error.message}`));
    }
    if (error instanceof Error && error.name.startsWith("PrismaClient")) {
      return err(queueUnavailable(`${label}: ${error.message}`));
    }
    throw error;
  }
}

/**
 * Two stored arrays as one plan, or a refusal.
 *
 * `EvalRun_pairs_check` already refuses a row whose two arrays differ in length
 * or disagree with `pairCount`, so this can only fire against a database whose
 * constraint was dropped or a binary reading a row an older schema wrote. It
 * fires rather than TRUNCATING to the shorter array, because a plan silently
 * shortened is a set of criteria nothing will ever score.
 */
function readPairs(
  threadIds: readonly string[],
  criterionIds: readonly string[],
  pairCount: number,
): readonly EvalPair[] {
  if (threadIds.length !== criterionIds.length || threadIds.length !== pairCount) {
    throw new UnreadableRowError(
      UNREADABLE_EVAL_RUN_PAIRS,
      "EvalRun.pairThreadIds/pairCriterionIds",
      `${String(threadIds.length)}/${String(criterionIds.length)} against pairCount ${String(pairCount)}`,
    );
  }
  return threadIds.map(
    (threadId, index) =>
      ({
        threadId: asGovernanceIdentifier(threadId),
        criterionId: asGovernanceIdentifier(criterionIds[index] as string),
      }) as EvalPair,
  );
}

export function createEvalRunStore(transactions: TenancyTransactions, now: () => Date): EvalRunStore {
  return {
    async enqueue(request: EvalRunRequest): Promise<Result<EnqueuedEvalRun>> {
      return refuseQueue(async () => {
        if (request.idempotencyKey.trim() === "") {
          throw new GovernanceWriteRefused(EVAL_RUN_KEY_EMPTY, "idempotencyKey is blank");
        }
        requireUuid("EvalRun.goldenSetId", request.goldenSetId);
        requireUuid("EvalRun.agentId", request.agentId);
        requireUuid("EvalRun.baselineVersionId", request.baselineVersionId);
        const digest = evalRunDigest(request.idempotencyKey);

        // `atomicResult` and not `atomic`: an `err` from inside it ROLLS BACK.
        // `atomic` is a pass-through to `UnitOfWork.run`, which REFUSES a
        // `Result`-valued callback outright — because a resolved callback
        // COMMITS, which is the defect `cost-monitoring` shipped, a threshold
        // event committed with no delivery rows beside it. A collision below is
        // an `err` returned from inside a transaction, so this is the one shape
        // that both compiles and rolls back.
        return transactions.atomicResult(async (client) => {
          const held = await client.evalRun.findFirst({
            where: { environmentId: request.scope.environmentId, idempotencyDigest: digest },
            select: { id: true, idempotencyKey: true, pairCount: true },
          });
          if (held !== null) return alreadyQueued(held as EvalRunRow, request);

          const at = now();
          const created = await client.evalRun.createManyAndReturn({
            data: [
              {
                environmentId: request.scope.environmentId,
                goldenSetId: request.goldenSetId,
                agentId: request.agentId,
                baselineVersionId: request.baselineVersionId,
                requestedBy: request.requestedBy,
                idempotencyKey: request.idempotencyKey,
                idempotencyDigest: digest,
                pairCount: request.pairs.length,
                pairThreadIds: request.pairs.map((pair) => String(pair.threadId)),
                pairCriterionIds: request.pairs.map((pair) => String(pair.criterionId)),
                createdAt: at,
                updatedAt: at,
              },
            ],
            // The read above is not a lock, so two processes can both miss and
            // both insert. `skipDuplicates` turns the loser's insert into zero
            // rows rather than a raised constraint — a raise would take the
            // caller's transaction away along with the answer, which is the
            // reason `governance-criteria.ts` gives for the same shape.
            skipDuplicates: true,
            select: { id: true, idempotencyKey: true, pairCount: true },
          });
          const row = created[0];
          if (row !== undefined) {
            return ok({
              runId: asGovernanceIdentifier<EvalRunId>(row.id),
              pairCount: row.pairCount,
              alreadyQueued: false,
            });
          }
          const winner = await client.evalRun.findFirst({
            where: { environmentId: request.scope.environmentId, idempotencyDigest: digest },
            select: { id: true, idempotencyKey: true, pairCount: true },
          });
          if (winner === null) {
            // The insert took no row and no row is there. Something refused the
            // write for a reason that is not this key, and answering
            // `alreadyQueued` would be a lie about work nobody is doing.
            return err(queueUnavailable("enqueue: insert took no row and none is present"));
          }
          return alreadyQueued(winner as EvalRunRow, request);
        });
      }, "enqueue");
    },

    async claim(owner: string, leaseMs: number, limit: number): Promise<Result<readonly ClaimedEvalRun[]>> {
      return refuseQueue(async () => {
        if (owner.trim() === "") {
          throw new GovernanceWriteRefused(EVAL_RUN_LEASE_INVALID, "owner is blank");
        }
        if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
          throw new GovernanceWriteRefused(EVAL_RUN_LEASE_INVALID, `leaseMs=${String(leaseMs)}`);
        }
        if (!Number.isSafeInteger(limit) || limit <= 0) {
          throw new GovernanceWriteRefused(EVAL_RUN_LEASE_INVALID, `limit=${String(limit)}`);
        }
        const at = now();
        const until = new Date(at.getTime() + leaseMs);
        // ONE STATEMENT, and that is the whole of the exclusivity guarantee. The
        // inner `SELECT ... FOR UPDATE SKIP LOCKED` locks the rows it returns and
        // steps over rows another transaction has already locked, so two
        // consumers running this at the same instant take DISJOINT sets. A
        // read-then-update in two statements has a window between them in which
        // both readers see the same row, and no amount of retrying closes it.
        //
        // The order is the queue's order — oldest first, ties broken by id —
        // spelled as SQL, because `LIMIT` without a total order takes an
        // arbitrary subset.
        const rows = await transactions.pool().$queryRaw<readonly ClaimedRow[]>`
          UPDATE "public"."EvalRun" AS run
          SET "status" = 'RUNNING',
              "leaseOwner" = ${owner},
              "leaseExpiresAt" = ${until},
              "deliveries" = run."deliveries" + 1,
              "updatedAt" = ${at}
          WHERE run."id" IN (
            SELECT candidate."id"
            FROM "public"."EvalRun" AS candidate
            WHERE candidate."status" = 'QUEUED'
               OR (candidate."status" = 'RUNNING' AND candidate."leaseExpiresAt" <= ${at})
            ORDER BY candidate."createdAt" ASC, candidate."id" ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING run."id",
                    run."environmentId",
                    run."goldenSetId",
                    run."agentId",
                    run."baselineVersionId",
                    run."pairThreadIds",
                    run."pairCriterionIds",
                    run."pairCount",
                    run."deliveries",
                    run."leaseExpiresAt"
        `;
        return ok(
          rows.map((row) => ({
            runId: asGovernanceIdentifier<EvalRunId>(row.id),
            environmentId: row.environmentId,
            goldenSetId: row.goldenSetId,
            agentId: row.agentId,
            baselineVersionId: row.baselineVersionId,
            pairs: readPairs(row.pairThreadIds, row.pairCriterionIds, row.pairCount),
            pairCount: row.pairCount,
            deliveries: row.deliveries,
            leaseExpiresAt: row.leaseExpiresAt,
          })),
        );
      }, "claim");
    },

    async acknowledge(runId: EvalRunId, owner: string): Promise<Result<boolean>> {
      return refuseQueue(async () => {
        requireUuid("EvalRun.id", runId);
        // `leaseOwner` IS IN THE PREDICATE, and that is what makes an
        // acknowledgement safe after a lease expired. A consumer that stalled
        // past its lease, had the run reclaimed by another, and then came back to
        // acknowledge would otherwise mark somebody else's in-flight delivery
        // finished. Here it updates nothing and is told so.
        const outcome = await transactions.pool().evalRun.updateMany({
          where: { id: runId, leaseOwner: owner, status: "RUNNING" },
          data: { status: "SUCCEEDED", leaseOwner: null, leaseExpiresAt: null, updatedAt: now() },
        });
        return ok(outcome.count > 0);
      }, "acknowledge");
    },

    async abandon(runId: EvalRunId, owner: string, reason: string): Promise<Result<boolean>> {
      return refuseQueue(async () => {
        requireUuid("EvalRun.id", runId);
        const outcome = await transactions.pool().evalRun.updateMany({
          where: { id: runId, leaseOwner: owner, status: "RUNNING" },
          data: {
            status: "QUEUED",
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: reason,
            updatedAt: now(),
          },
        });
        return ok(outcome.count > 0);
      }, "abandon");
    },
  };
}

/**
 * The answer to a key that has been accepted before — or the refusal of one that
 * only looks like it has.
 *
 * A SHA-256 collision has never been exhibited and this branch has never run.
 * It exists because the alternative to checking is `alreadyQueued: true` for a
 * DIFFERENT run: the caller is told its fan-out is already in flight, no row is
 * written, and nothing ever scores it. A silent no-op is the worst answer
 * available here, so the stored key is compared and a mismatch is refused.
 */
function alreadyQueued(row: EvalRunRow, request: EvalRunRequest): Result<EnqueuedEvalRun> {
  if (row.idempotencyKey !== request.idempotencyKey) {
    return err(
      queueUnavailable(`${EVAL_RUN_DIGEST_COLLISION}: two distinct run keys share one digest`),
    );
  }
  return ok({
    runId: asGovernanceIdentifier<EvalRunId>(row.id),
    pairCount: row.pairCount,
    alreadyQueued: true,
  });
}
