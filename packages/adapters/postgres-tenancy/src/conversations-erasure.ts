// The `ConversationsErasureStore` — the only file in this package that deletes a
// row, and the one where the real database contradicted this file four times.
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
// FINDING 1 — THE `SetNull` CASCADE ONTO `PostmanExecution` REFUSES ITSELF
// ---------------------------------------------------------------------------
//
// This one cost an integration run rather than being read out of the migrations
// first, and it is the sharpest thing the real database said.
//
// `PostmanExecution.thread` and `PostmanExecution.turn` are BOTH
// `onDelete: SetNull`, so deleting a thread makes PostgreSQL issue the nulling
// UPDATEs itself. They are two separate foreign-key constraints and are applied
// as two separate statements, so between them the row is `threadId = NULL` with
// `turnId` still set — and `PostmanExecution_ancestry` fires BEFORE UPDATE. Its
// turn clause is
// `LEFT JOIN "Turn" turn ON turn.id = NEW."turnId" AND turn."threadId" = thread.id`,
// which cannot resolve against a null thread, so the rule refuses the row and
// the DELETE fails with `PostmanExecution crosses its canonical owner ancestry`
// — a message naming neither the execution nor the thread.
//
// The effect is that an erasure is impossible for any subject an operator ever
// ran a SETTLED postman request against, which is every subject a support
// engineer has ever reproduced a bug for. Clearing BOTH columns in ONE update
// first satisfies the rule, because both of its clauses are
// `NEW."x" IS NULL OR …`. The in-memory double sees none of it: it has no
// cascade, no trigger and no statement order.
//
// ---------------------------------------------------------------------------
// FINDING 2 — THE FORK RESTRICT BLOCKS A LOOP AND NOT A SINGLE STATEMENT
// ---------------------------------------------------------------------------
//
// `Thread_forkedUpToTurnId_fkey` is `ON DELETE RESTRICT`, and it is the ONLY
// restricting foreign key pointing into any of this context's four rows. A fork
// names the ancestor turn it branched at; deleting the ancestor THREAD cascades
// to that turn; and the RESTRICT is checked when the TURN goes.
//
// WHICH ORDER THOSE HAPPEN IN IS THE WHOLE FINDING. Deleting the ancestor ALONE
// is refused. Deleting the ancestor AND the fork in ONE statement is admitted,
// because PostgreSQL removes every `Thread` row the statement names before the
// cascade to `Turn` runs, and by then nothing references the turn.
//
// AND THE REFUSAL A CALLER MEETS IS NOT THE RESTRICT. `Thread.parentThreadId` is
// `onDelete: SetNull`, so deleting the ancestor first makes the database UPDATE
// the fork — and `Thread_ancestry` fires BEFORE UPDATE, where its lineage clause
// requires a parent to exist whenever `forkedTurnIds` is non-empty. That refusal
// arrives first, with `Thread crosses its canonical owner ancestry`, and the
// RESTRICT is behind it. Two rules, one outcome, and neither message names the
// fork.
//
// So a per-thread loop — the obvious shape, and the one the first draft of this
// file used — fails on the first ancestor it reaches, and a single `deleteMany`
// over the subject's threads does not. That is why the delete below is one
// statement, and `conversations-rules.integration.test.ts` pins BOTH halves:
// the ancestor alone is refused, the whole subject is not.
//
// AND THE LINK CANNOT BE BROKEN FIRST EITHER. `forkedUpToTurnId` is one of the
// four columns `Thread_owner_immutable` freezes, and nulling it while
// `forkedTurnIds` is non-empty ALSO breaks the lineage clause of
// `Thread_ancestry`, which runs first and is the refusal a caller actually sees.
// Two rules, one message.
//
// ---------------------------------------------------------------------------
// FINDING 3 — `findHeldThreads` HAS NO COLUMN, AND ITS TRUTHFUL ANSWER IS THIN
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
// FINDING 4 — `anonymizeExecutionsForActor` CANNOT SEVER WHAT ITS DOC SAYS
// ---------------------------------------------------------------------------
//
// The port's comment reads "The same severing for an operator subject, on
// `actorUserId`". THE DATABASE FORBIDS THAT FOUR TIMES OVER: `actorUserId` is
// NOT NULL, its foreign key is `ON DELETE RESTRICT` to `User`,
// `prevent_postman_execution_attribution_mutation` raises SQLSTATE 55000 on any
// UPDATE that changes it, and `PostmanExecution_ancestry` joins `"User" actor ON
// actor.id = NEW."actorUserId"` so a null refuses there FIRST — which is the
// message the integration run actually produced. There is no value this store
// could write.
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
        const doomed = organizationThreadWhere(subjectId, organizationId);
        // THE EXECUTION LINKS ARE CLEARED FIRST, IN ONE STATEMENT, and this is
        // the half that cost an integration run. See FINDING 1 in the header:
        // `PostmanExecution.thread` and `.turn` are both `onDelete: SetNull`,
        // the two foreign keys null in two separate statements, and
        // `PostmanExecution_ancestry` sees the half-nulled row and refuses the
        // delete with `PostmanExecution crosses its canonical owner ancestry`.
        // Clearing BOTH columns in one update satisfies the rule, because both
        // of its clauses are `NEW."x" IS NULL OR …`.
        await client.postmanExecution.updateMany({
          where: { thread: doomed },
          data: { threadId: null, turnId: null },
        });
        // ONE DELETE FOR THE WHOLE SUBJECT, forks included, and see FINDING 2:
        // a per-thread loop would be refused by `Thread_forkedUpToTurnId_fkey`
        // the moment it reached an ancestor before its fork, while the single
        // statement is admitted because every referencing thread goes with it.
        const outcome = await client.thread.deleteMany({ where: doomed });
        return ok(outcome.count);
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
