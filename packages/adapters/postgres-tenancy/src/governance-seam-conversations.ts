// Two of `governance`'s three inverted read seams — the two whose rows belong to
// `conversations`.
//
// WHY THEY ARE IN THIS DIRECTORY AT ALL, MEASURED RATHER THAN ASSERTED.
// `read-seams.ts` says the composition root implements these "by asking
// whichever context owns the rows". `Thread` and `Turn` are owned by
// `conversations` (ADR M0.3 §1 row 16) — and `CANONICAL_STORE_ADAPTERS` in
// `scripts/arch/table-ownership.mjs` maps `conversations`, like all EIGHTEEN
// owners, to `packages/adapters/postgres-tenancy`. This directory is not a
// stranger reaching sideways into somebody else's tables: under ADR M0.3 §15 it
// IS `conversations`' canonical store, the sole writer of both rows, and
// `conversations-threads.ts` and `conversations-turns.ts` sit beside this file.
// Asking the owner and asking this directory are the same act.
//
// `governance-repository.ts` USED TO SAY THE OPPOSITE and its header has been
// corrected in the same commit. The sentence there — "implementing them here
// would make this directory a reader of four other owners' tables" — described a
// tree in which those owners lived somewhere else. They never did.
//
// AND THEY ARE STILL NOT `GovernanceStores`. That object is the five ports
// `governance` is SOLE WRITER of, and these two write nothing and own nothing.
// They are assembled separately, in `governance-read-seams.ts`, and bound as
// their own rows — so a reader of the binding table can see that three of
// governance's ports are answered from other owners' rows, which is exactly the
// fact ADR M0.3 §2 inverted the seam to make visible.
//
// ---------------------------------------------------------------------------
// THE NARROWING IS THE WHOLE OF THE DANGER, AND IT IS NOT SYMMETRIC.
//
// `Thread` carries `environmentId`. `Turn` DOES NOT — read the model: its
// columns are `threadId`, `agentVersionId`, `sequence` and the text, and its
// tenancy is entirely its thread's. So `prisma.turn.findUnique({ where: { id } })`
// is a correct-looking statement that answers with ANY tenant's turn, and no
// type in this package would object. Both readers below narrow through
// `Thread.environmentId` and `read-seams.integration.test.ts` proves it against
// a SECOND, FOREIGN tenant seeded by `governance-harness.ts` — not against a
// double that was told to hide the row.
//
// WHAT THE MIGRATIONS GUARANTEE, AND WHAT THEY DO NOT. `Turn_ancestry`
// (00000000000000_initial, the `enforce_domain_ancestry` trigger) refuses any
// turn whose `AgentVersion.agentId` is not its thread's `agentId`. That is why
// `RatingTarget.agentId` is taken from the THREAD and `agentVersionId` from the
// TURN and the two cannot disagree: the database will not hold a row where they
// do. Nothing in the migrations, however, constrains a turn to an environment
// directly — there is no column to constrain — which is the same fact from the
// other side.
// ---------------------------------------------------------------------------

import type {
  AgentId,
  AgentVersionId,
  EndUserId,
  EnvironmentScope,
  RatingTarget,
  RatingTargetReader,
  Result,
  ThreadId,
  Transcript,
  TranscriptReader,
  TranscriptTurn,
  TurnId,
} from "@platos/context-governance/application/ports/index.js";
import {
  asGovernanceIdentifier,
  err,
  ok,
  ratingTargetUnreadable,
  transcriptUnreadable,
} from "@platos/context-governance/application/ports/index.js";

import { refuse } from "./governance-refusal.js";
import { narrowableEnvironment, narrowableRowId } from "./governance-seam-guards.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The four fields a rating is attributed by, and not one more.
 *
 * A `select` rather than the row, for the reason `SafetyLedger.tally`'s is: the
 * turn carries `inputText`, `outputText`, `thinkingContent` and two JSON columns,
 * and a reader whose job is to say WHOSE turn this is has no business loading
 * what the turn said. It also keeps this seam from becoming the back door onto
 * `conversations`' model that `read-seams.ts`' header warns about — the port can
 * only carry these four, so this is all that leaves the database.
 */
const RATING_TARGET_COLUMNS = {
  id: true,
  threadId: true,
  agentVersionId: true,
  thread: { select: { agentId: true, endUserId: true } },
} as const;

/** The three fields a judge is shown, plus the version that produced them. */
const TRANSCRIPT_TURN_COLUMNS = {
  id: true,
  inputText: true,
  outputText: true,
  agentVersionId: true,
} as const;

export function createRatingTargetReader(transactions: TenancyTransactions): RatingTargetReader {
  return {
    async find(scope: EnvironmentScope, turnId: TurnId): Promise<Result<RatingTarget | null>> {
      const environmentId = narrowableEnvironment(scope);
      if (environmentId === null) {
        return err(ratingTargetUnreadable(`no environment to narrow by: ${String(scope.environmentId)}`));
      }
      const rowId = narrowableRowId(turnId);
      // A MISTYPED TURN IS ABSENT, NOT AN ERROR. The port says a turn in another
      // environment must be indistinguishable from a typo; answering `null`
      // without a statement is the same answer the narrowed read would give, and
      // it costs nothing.
      if (rowId === null) return ok(null);
      return refuse(async () => {
        // `findFirst` AND NOT `findUnique`, and the difference is the whole
        // guarantee. `findUnique` takes only the primary key, so the relation
        // filter could not be expressed at all and the narrowing would have to
        // happen in TypeScript AFTER another tenant's row had been loaded.
        const row = await transactions.reader().turn.findFirst({
          where: { id: rowId, thread: { environmentId } },
          select: RATING_TARGET_COLUMNS,
        });
        if (row === null) return ok(null);
        return ok({
          turnId: asGovernanceIdentifier<TurnId>(row.id),
          threadId: asGovernanceIdentifier<ThreadId>(row.threadId),
          // FROM THE THREAD, because that is what a rating is attributed to and
          // what `Thread_ancestry` binds to this environment. `Turn_ancestry`
          // makes it equal to the agent behind `agentVersionId`.
          agentId: asGovernanceIdentifier<AgentId>(row.thread.agentId),
          endUserId: asGovernanceIdentifier<EndUserId>(row.thread.endUserId),
          // FROM THE TURN, and the port's header says why: stamping a rating
          // with whichever version is live now credits a promotion with the old
          // version's output. `Turn.agentVersionId` is NOT NULL in the schema,
          // so this branch of the port's nullability is one this implementation
          // never takes.
          agentVersionId: asGovernanceIdentifier<AgentVersionId>(row.agentVersionId),
        });
      }, "governance ratingTargets find");
    },
  };
}

export function createTranscriptReader(transactions: TenancyTransactions): TranscriptReader {
  return {
    async read(
      scope: EnvironmentScope,
      threadId: ThreadId,
      turnId: TurnId | null,
    ): Promise<Result<Transcript | null>> {
      const environmentId = narrowableEnvironment(scope);
      if (environmentId === null) {
        return err(transcriptUnreadable(`no environment to narrow by: ${String(scope.environmentId)}`));
      }
      const threadRowId = narrowableRowId(threadId);
      if (threadRowId === null) return ok(null);
      const turnRowId = turnId === null ? null : narrowableRowId(turnId);
      return refuse(async () => {
        // THE THREAD IS RESOLVED FIRST, AND NARROWED. Reading the turns by
        // `threadId` alone would answer another tenant's conversation in full,
        // and this is the read a judge is PAID to consume.
        const thread = await transactions.reader().thread.findFirst({
          where: { id: threadRowId, environmentId },
          select: { id: true, agentId: true },
        });
        if (thread === null) return ok(null);

        // A NAMED TURN THAT IS NOT A UUID YIELDS AN EMPTY LIST, not the whole
        // thread. The port's own words: "a mistyped id cannot silently widen
        // what a judge is paid to read". The `id` filter below does the same for
        // a well-formed id that is not in this thread.
        const turns =
          turnId !== null && turnRowId === null
            ? []
            : await transactions.reader().turn.findMany({
                where: {
                  threadId: thread.id,
                  // CANCELLED IS EXCLUDED BY THE PORT: "a cancelled turn is not
                  // included". `not` rather than an `in` list of the other four,
                  // so a `WorkStatus` this binary has not learned is still shown
                  // to the judge rather than silently dropped from the evidence.
                  status: { not: "CANCELLED" },
                  ...(turnRowId === null ? {} : { id: turnRowId }),
                },
                orderBy: { sequence: "asc" },
                select: TRANSCRIPT_TURN_COLUMNS,
              });

        return ok({
          threadId: asGovernanceIdentifier<ThreadId>(thread.id),
          agentId: asGovernanceIdentifier<AgentId>(thread.agentId),
          turns: turns.map(
            (turn): TranscriptTurn => ({
              turnId: asGovernanceIdentifier<TurnId>(turn.id),
              input: turn.inputText,
              output: turn.outputText,
              agentVersionId: asGovernanceIdentifier<AgentVersionId>(turn.agentVersionId),
            }),
          ),
        });
      }, "governance transcripts read");
    },
  };
}
