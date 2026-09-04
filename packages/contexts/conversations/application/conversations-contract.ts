// The binder: every use case in this context, as one frozen object.
//
// NOBODY IMPORTS THIS CONTEXT, AND THAT IS THE POINT OF THE WHOLE EXTRACTION.
// ADR M0.3 §1 row 16 makes `conversations` the DEEPEST node in the DAG — eleven
// dependencies, zero dependents — and says why: "every reverse/fan-out flow
// leaves as a domain event or a durable job, so NO context imports
// conversations." `audit:arch-boundaries` enforces both halves, and this
// contract is therefore reached ONLY by the composition root and the transports
// it wires. `governance` reads turns and transcripts through inverted ports of
// its own for exactly this reason.
//
// THE TARGET IS BUILT ONCE, NOT PER CALL. `files` and `governance` do it this
// way and their headers say why: a composition root handed a fresh
// `ErasureTarget` on each call could inject two into `privacy` and count the
// same rows twice.
//
// THE CONTRACT IS FROZEN. A caller cannot monkey-patch a method onto the
// published surface, which is how a transport starts depending on behaviour no
// test covers.

import type { ErasureTarget, Result } from "@platos/kernel";

import type {
  PostmanExecution,
  Step,
  Thread,
  Turn,
} from "../domain/index.js";
import { createConversationsErasureTarget } from "./conversations-erasure-target.js";
import type { ConversationsDependencies } from "./dependencies.js";
import {
  completeConversationCompaction,
  planConversationCompaction,
  type CompactThreadCommand,
  type CompactionQueued,
  type CompleteCompactionCommand,
} from "./compact-thread.js";
import {
  describeExecution,
  launchPostmanExecution,
  settleExecution,
  type DescribePostmanQuery,
  type LaunchPostmanCommand,
  type LaunchedPostman,
  type SettlePostmanCommand,
} from "./execute-postman.js";
import { forkConversation, type ForkThreadCommand } from "./fork-thread.js";
import {
  describeConversation,
  describeConversationTurn,
  inspectConversation,
  openConversation,
  pageConversationTurns,
  pageConversations,
  type DescribeThreadQuery,
  type DescribeTurnQuery,
  type InspectThreadQuery,
  type OpenThreadCommand,
  type PageThreadsQuery,
  type PageTurnsQuery,
  type TurnTrace,
} from "./manage-threads.js";
import type { ThreadPage, TurnPage } from "./ports/index.js";
import { runTurn, type RanTurn, type RunTurnCommand } from "./run-turn.js";

/**
 * The `conversations` capability, as the composition root sees it.
 *
 * Every method returns the kernel `Result`: a failure a caller must handle is
 * visible in the type, and no store or provider exception crosses this boundary.
 */
export interface ConversationsContract {
  readonly name: "conversations";

  // ---- threads (runtime grant: the end user's own) ------------------------
  openThread(command: OpenThreadCommand): Promise<Result<Thread>>;
  /** The end user's read. Somebody else's thread is `not_found`, not `forbidden`. */
  describeThread(query: DescribeThreadQuery): Promise<Result<Thread>>;
  /** A fork REFERENCES its ancestry; it copies no turn and no ledger row. */
  forkThread(command: ForkThreadCommand): Promise<Result<Thread>>;

  // ---- threads (operator grant: the whole environment) --------------------
  /** The operator's read. A foreign thread is `forbidden`: the row is known to exist. */
  inspectThread(query: InspectThreadQuery): Promise<Result<Thread>>;
  pageThreads(query: PageThreadsQuery): Promise<Result<ThreadPage>>;
  pageTurns(query: PageTurnsQuery): Promise<Result<TurnPage>>;
  /** One turn and every step it produced — the trace a bill is read off. */
  describeTurn(query: DescribeTurnQuery): Promise<Result<TurnTrace>>;

  // ---- the turn engine ---------------------------------------------------
  /**
   * Run one turn to completion.
   *
   * The tool loop, the step budget and the cache-breakpoint placement all live
   * BEHIND `providers`' `ModelRouter`; this context supplies the prompt, the
   * catalogue and a function that runs one tool. `RanTurn.replayed` is true when
   * an idempotency key matched an earlier delivery, in which case no second turn
   * was made and no money was spent.
   */
  runTurn(command: RunTurnCommand): Promise<Result<RanTurn>>;

  // ---- compaction --------------------------------------------------------
  /** Take the lock and hand the summarising to `jobs`. Answers the plan, not a summary. */
  planCompaction(command: CompactThreadCommand): Promise<Result<CompactionQueued>>;
  /** What the durable job calls back with. Refuses a cursor that moved backwards. */
  completeCompaction(command: CompleteCompactionCommand): Promise<Result<Thread>>;

  // ---- postman -----------------------------------------------------------
  /** Operator grant AND runtime grant. Neither substitutes for the other. */
  launchExecution(command: LaunchPostmanCommand): Promise<Result<LaunchedPostman>>;
  settleExecution(command: SettlePostmanCommand): Promise<Result<PostmanExecution>>;
  describeExecution(query: DescribePostmanQuery): Promise<Result<PostmanExecution>>;

  /**
   * This context's `ErasureTarget` for the four rows it is sole writer of.
   *
   * The composition root collects one per context and injects the array into
   * `privacy` (ADR M0.3 §3). IT IS ON THE CONTRACT BECAUSE THERE IS NO OTHER
   * DOOR: `package.json` publishes exactly two entrypoints, this barrel and
   * `application/ports/index.js`, so a target reachable from neither is
   * reachable from the composition root not at all. `Turn.inputText` is what a
   * subject actually said, which makes an unpublished target here a
   * right-to-erasure operation that reports success and leaves the subject's own
   * words in the database.
   */
  erasureTarget(): ErasureTarget;
}

/** The row this context hands out as its aggregate: a conversation. */
export type ConversationsAggregate = Thread;

export type { RanTurn, Step, Turn, TurnTrace };

export function createConversationsContract(
  dependencies: ConversationsDependencies,
): ConversationsContract {
  const erasure: ErasureTarget = createConversationsErasureTarget(dependencies);

  const contract: ConversationsContract = {
    name: "conversations",

    openThread: (command) => openConversation(dependencies, command),
    describeThread: (query) => describeConversation(dependencies, query),
    forkThread: (command) => forkConversation(dependencies, command),

    inspectThread: (query) => inspectConversation(dependencies, query),
    pageThreads: (query) => pageConversations(dependencies, query),
    pageTurns: (query) => pageConversationTurns(dependencies, query),
    describeTurn: (query) => describeConversationTurn(dependencies, query),

    runTurn: (command) => runTurn(dependencies, command),

    planCompaction: (command) => planConversationCompaction(dependencies, command),
    completeCompaction: (command) => completeConversationCompaction(dependencies, command),

    launchExecution: (command) => launchPostmanExecution(dependencies, command),
    settleExecution: (command) => settleExecution(dependencies, command),
    describeExecution: (query) => describeExecution(dependencies, query),

    erasureTarget: () => erasure,
  };

  return Object.freeze(contract);
}
