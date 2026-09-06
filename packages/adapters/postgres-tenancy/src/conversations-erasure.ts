// The `ConversationsErasureStore` — the only file in this package that deletes a
// row, and the one where the real database contradicted the port twice.
//
// ---------------------------------------------------------------------------
// EVERY METHOD IS SCOPED TO AN ORGANIZATION, AND NO ROW HERE HAS ONE
// ---------------------------------------------------------------------------
//
// `privacy` addresses a subject at an ORGANIZATION; `Thread` stores an
// `environmentId` and `PostmanExecution` stores an `environmentId`, and neither
// stores an organization. So every predicate below reaches
// `environment -> project -> organizationId` as a RELATION filter the database
// resolves inside the same statement. The obvious wrong implementation — list
// the organization's environments, then one query per environment — is an N+1 in
// the TENANT TREE rather than in the rows, invisible on a fixture with one
// environment and linear in a real installation.
//
// The in-memory double ignores `organizationId` entirely: it filters on the
// subject alone. That is safe in a fixture with one tenant and is the exact
// shape of the cross-tenant erasure a real store must not perform, so the
// containment is proved against a SECOND organization in
// `conversations-rules.integration.test.ts` rather than left to the differential,
// which cannot see it.
//
// ---------------------------------------------------------------------------
// FINDING 1 — THE THREADS ARE DELETED PARENT-LAST, OR THE ERASURE FAILS
// ---------------------------------------------------------------------------
//
// `Thread_forkedUpToTurnId_fkey` is `ON DELETE RESTRICT`, and it is the ONLY
// restricting foreign key pointing into any of this context's four rows. A fork
// names the ancestor turn it branched at; deleting the ancestor THREAD cascades
// to that turn; RESTRICT then refuses the delete — and RESTRICT is not deferred,
// so it refuses even when the fork is being deleted in the SAME statement.
//
// A single `deleteMany` over a subject's threads therefore FAILS for any subject
// who has ever forked a conversation, with SQLSTATE 23503 and a message naming
// neither the thread nor the fork. The in-memory double cannot see this: it
// deletes from a Map, in insertion order, with no referential integrity at all.
//
// AND THE LINK CANNOT BE BROKEN FIRST. `Thread_owner_immutable` lists
// `forkedUpToTurnId` among the columns `reject_canonical_owner_change` refuses to
// let an UPDATE change, so nulling it before the delete is refused by a second
// rule. The only remaining order is DEEPEST FIRST, which is what this does.
//
// ---------------------------------------------------------------------------
// FINDING 2 — `findHeldThreads` HAS NO COLUMN, AND ITS TRUTHFUL ANSWER IS THIN
// ---------------------------------------------------------------------------
//
// The port asks for "threads an operator hold or retention rule blocks". There
// is NO legal-hold column on `Thread`, and none anywhere in the canonical schema
// that reaches one: `ErasureOperation.legalHoldPolicyId` belongs to `privacy` and
// names a POLICY rather than a thread. The double answers from a `Set` a test
// populates by hand, which is not a mechanism this store has.
//
// What the database DOES have is the RESTRICT above, so the honest reading of
// "blocked" is "the database will refuse to delete it": a thread one of whose
// turns is another thread's fork boundary, where that other thread is NOT itself
// in the erasure. This store answers exactly that.
//
// THAT SET IS PROVABLY EMPTY UNDER `enforce_domain_ancestry`, and saying so is
// the point rather than an admission. The Thread branch of that rule requires a
// fork's parent to share its child's environment AND its child's end user, and
// `Thread_subject_immutable` forbids moving a thread to another subject
// afterwards — so every fork of a subject's thread belongs to that same subject
// and is inside the erasure. The query is therefore a live check of an invariant
// two triggers maintain, not a stub: if a migration relaxed either one, this
// would start naming threads and the plan would start reporting a block.
// `conversations-rules.integration.test.ts` seeds a real fork and pins the EMPTY
// answer, so a mutation that drops the "outside the erasure" clause turns red.
//
// ---------------------------------------------------------------------------
// FINDING 3 — `anonymizeExecutionsForActor` CANNOT SEVER WHAT ITS DOC SAYS
// ---------------------------------------------------------------------------
//
// The port's comment reads "The same severing for an operator subject, on
// `actorUserId`". THE DATABASE FORBIDS THAT THREE TIMES OVER: `actorUserId` is
// NOT NULL, its foreign key is `ON DELETE RESTRICT` to `User`, and
// `prevent_postman_execution_attribution_mutation` raises SQLSTATE 55000 on any
// UPDATE that changes it. There is no value this store could write.
//
// The in-memory double does NOT sever `actorUserId` either — it nulls
// `simulatedEndUserId` on the executions that actor launched — and the erasure
// target's own header agrees with the double: "`actorUserId` is `onDelete:
// Restrict` to `User`: the row is an audit trail and deleting it would erase the
// record that an operator ran an agent, which is not the subject's data to
// erase. What goes is the LINK". So the MECHANISM is settled and only the port
// comment's one sentence is wrong. This store implements the mechanism, the
// contradiction is pinned as a named case, and it is reported rather than
// quietly reconciled.

import {
  ok,
  type ConversationsErasureStore,
  type EndUserId,
  type ErasureCensus,
  type Result,
  type ThreadId,
  type TransactionScope,
} from "@platos/context-conversations/application/ports/index.js";

import { refuse } from "./conversations-refusal.js";
import type { TenancyTransactions } from "./transaction.js";

/** Threads of one organization. A relation filter, resolved in one statement. */
function organizationThreadWhere(
  subjectId: EndUserId,
  organizationId: string,
): Record<string, unknown> {
  return {
    endUserId: subjectId,
    environment: { project: { organizationId } },
  };
}

/** Executions of one organization, selected by whichever party names the subject. */
function organizationExecutionWhere(
  column: "simulatedEndUserId" | "actorUserId",
  subjectId: string,
  organizationId: string,
): Record<string, unknown> {
  return {
    [column]: subjectId,
    environment: { project: { organizationId } },
  };
}

interface HeldThreadRow {
  readonly heldThreadId: string;
}

interface DoomedThreadRow {
  readonly doomedThreadId: string;
}

export function createConversationsErasureStore(
  transactions: TenancyTransactions,
): ConversationsErasureStore {
  return {
    async censusForEndUser(
      subjectId: EndUserId,
      organizationId: string,
    ): Promise<Result<ErasureCensus>> {
      return refuse(async () => {
        const reader = transactions.reader();
        const threadWhere = organizationThreadWhere(subjectId, organizationId);
        // FOUR COUNTS, FOUR STATEMENTS, AND NOT ONE PER ROW. Each is a `count`
        // whose predicate reaches down the relation graph, so a subject with one
        // thread and a subject with ten thousand cost the same four statements.
        // `plan` MUST NOT MUTATE and these are the whole of what it does.
        const threadCount = await reader.thread.count({ where: threadWhere });
        const turnCount = await reader.turn.count({ where: { thread: threadWhere } });
        const stepCount = await reader.step.count({ where: { turn: { thread: threadWhere } } });
        const postmanExecutionCount = await reader.postmanExecution.count({
          where: organizationExecutionWhere("simulatedEndUserId", subjectId, organizationId),
        });
        return ok({ threadCount, turnCount, stepCount, postmanExecutionCount });
      }, "erasure censusForEndUser");
    },

    async censusForActor(
      subjectId: string,
      organizationId: string,
    ): Promise<Result<ErasureCensus>> {
      return refuse(async () => {
        // THREE ZEROS AND ONE COUNT, and the zeros are answered WITHOUT A
        // STATEMENT. An operator authors no conversation — `Thread.endUserId` is
        // an `EndUser` and an operator is a `User`, two different tables — so
        // counting threads for one would be a query whose answer the schema
        // already guarantees. The erasure target names the models with zeros
        // anyway, so a reader comparing two plans sees the SUBJECT differ rather
        // than a target that forgot a model.
        const postmanExecutionCount = await transactions.reader().postmanExecution.count({
          where: organizationExecutionWhere("actorUserId", subjectId, organizationId),
        });
        return ok({ threadCount: 0, turnCount: 0, stepCount: 0, postmanExecutionCount });
      }, "erasure censusForActor");
    },

    async deleteThreadsForEndUser(
      subjectId: EndUserId,
      organizationId: string,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuse(async () => {
        const client = transactions.writer(transaction);
        // ORDERED DEEPEST FIRST. See FINDING 1 in the header: a single
        // `deleteMany` is refused by `Thread_forkedUpToTurnId_fkey` for any
        // subject who forked, and the link cannot be nulled first because
        // `Thread_owner_immutable` refuses that too.
        //
        // ONE statement computes the order — a recursive walk down
        // `parentThreadId` from the subject's roots — so the cost is one query
        // plus one delete per DEPTH, never per thread.
        const doomed = await client.$queryRaw<readonly DoomedThreadRow[]>`
          WITH RECURSIVE lineage("id", "depth") AS (
            SELECT thread."id", 0
              FROM "Thread" thread
              JOIN "Environment" environment ON environment."id" = thread."environmentId"
              JOIN "Project" project ON project."id" = environment."projectId"
             WHERE thread."endUserId" = ${subjectId}::uuid
               AND project."organizationId" = ${organizationId}::uuid
               AND thread."parentThreadId" IS NULL
            UNION ALL
            SELECT fork."id", lineage."depth" + 1
              FROM lineage
              JOIN "Thread" fork ON fork."parentThreadId" = lineage."id"
          )
          SELECT lineage."id" AS "doomedThreadId"
            FROM lineage
           ORDER BY lineage."depth" DESC
        `;
        // A thread whose parent is NOT the subject's cannot exist —
        // `enforce_domain_ancestry` requires a fork's parent to share its end
        // user — so the walk from the roots reaches every one of them. The
        // count is taken from the deletes rather than from this list, so a walk
        // that missed a thread reports fewer than it planned rather than
        // claiming the plan's number.
        let deleted = 0;
        for (const row of doomed) {
          const outcome = await client.thread.deleteMany({ where: { id: row.doomedThreadId } });
          deleted += outcome.count;
        }
        return ok(deleted);
      }, "erasure deleteThreadsForEndUser");
    },

    async anonymizeExecutionsForEndUser(
      subjectId: EndUserId,
      organizationId: string,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuse(async () => {
        // ANONYMIZE, NEVER DELETE. `simulatedEndUserId` is the LINK and its own
        // column is already `onDelete: SetNull`, so nulling it is what the schema
        // says should happen when the end user goes. Everything else on the row —
        // who ran it, against which agent, when — survives, because that is the
        // operator's audit trail and not the subject's data.
        //
        // `PostmanExecution_ancestry` FIRES ON THIS UPDATE and passes because of
        // the way it is written: the thread clause is
        // `NEW."simulatedEndUserId" IS NULL OR thread."endUserId" = NEW."simulatedEndUserId"`,
        // so severing the link satisfies it where changing it to another subject
        // would not.
        const outcome = await transactions.writer(transaction).postmanExecution.updateMany({
          where: organizationExecutionWhere("simulatedEndUserId", subjectId, organizationId),
          data: { simulatedEndUserId: null },
        });
        return ok(outcome.count);
      }, "erasure anonymizeExecutionsForEndUser");
    },

    async anonymizeExecutionsForActor(
      subjectId: string,
      organizationId: string,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuse(async () => {
        // SEVERS `simulatedEndUserId`, NOT `actorUserId`. See FINDING 3 in the
        // header: the column the port's comment names cannot be written at all —
        // NOT NULL, `onDelete: Restrict`, and immutable under a trigger that
        // raises SQLSTATE 55000 — and the erasure target's own header, and the
        // in-memory double, both already do it this way.
        const outcome = await transactions.writer(transaction).postmanExecution.updateMany({
          where: organizationExecutionWhere("actorUserId", subjectId, organizationId),
          data: { simulatedEndUserId: null },
        });
        return ok(outcome.count);
      }, "erasure anonymizeExecutionsForActor");
    },

    async findHeldThreads(
      subjectId: EndUserId,
      organizationId: string,
    ): Promise<Result<readonly ThreadId[]>> {
      return refuse(async () => {
        // See FINDING 2 in the header. A held thread is one the DATABASE would
        // refuse to delete: it owns a turn that is some other thread's
        // `forkedUpToTurnId`, and that other thread is NOT itself in this
        // erasure. The second half is the whole guard — without it every
        // ancestor of a fork would be reported as blocked and every plan for a
        // subject who forked would say so falsely.
        const rows = await transactions.reader().$queryRaw<readonly HeldThreadRow[]>`
          SELECT DISTINCT held."id" AS "heldThreadId"
            FROM "Thread" held
            JOIN "Environment" environment ON environment."id" = held."environmentId"
            JOIN "Project" project ON project."id" = environment."projectId"
            JOIN "Turn" turn ON turn."threadId" = held."id"
            JOIN "Thread" fork ON fork."forkedUpToTurnId" = turn."id"
           WHERE held."endUserId" = ${subjectId}::uuid
             AND project."organizationId" = ${organizationId}::uuid
             AND fork."endUserId" <> ${subjectId}::uuid
           ORDER BY held."id"
        `;
        return ok(rows.map((row) => row.heldThreadId as ThreadId));
      }, "erasure findHeldThreads");
    },
  };
}
