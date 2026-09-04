// The three READ SEAMS this context inverts rather than importing across.
//
// ADR M0.3 §1 row 14 allows `governance` exactly `tenancy`, `agents` and the
// kernel. Three of its questions are about rows those three do not own:
//
//   Which turn is this, whose is it, and what agent produced it?  `conversations`
//   What did this conversation actually say?                      `conversations`
//   How many turns, tool failures and approvals did each agent    `conversations`,
//   have in the window?                                           `tools`, `jobs`
//
// The source answers all three by reaching straight into `prisma.turn`,
// `prisma.toolCallAudit` and `prisma.agentApproval` from inside the monitoring
// module. Under the §1 DAG that is three edges this context may not have, and
// under §5.2 two of them are reads of tables another context is sole writer of.
//
// ADR M0.3 §2 names the fix: "reader-port dependency-inversion applied
// selectively at read-seams". The port is DECLARED HERE, by the context that
// needs the answer, in the vocabulary that context thinks in; the composition
// root implements it by asking whichever context owns the rows. So the arrow
// points from the adapter inward, `governance` names no peer it may not name,
// and the day `conversations` becomes real the implementation changes and this
// file does not.
//
// THESE ARE READS AND ONLY READS. Nothing here writes, and nothing here returns
// a row another context owns — only the few fields this context needs, in its
// own branded identifiers. That is what keeps a read seam from becoming a
// back door onto somebody else's model.

import type { EnvironmentScope, Result } from "@platos/kernel";

import type { AgentId, EndUserId, ThreadId, TranscriptTurn, TurnId } from "../../domain/index.js";

/**
 * What a rating needs to know about the turn it is attached to.
 *
 * The source derives all four fields with one nested query and uses them to
 * attribute the rating; here they arrive as a value, so the attribution rule is
 * testable without a database and the ownership question is answered by whoever
 * implements this.
 */
export interface RatingTarget {
  readonly turnId: TurnId;
  readonly threadId: ThreadId;
  readonly agentId: AgentId;
  /** Whose conversation this is. The rating's subject must match it. */
  readonly endUserId: EndUserId;
}

export interface RatingTargetReader {
  /**
   * Resolve one turn inside this environment, or null.
   *
   * An implementation MUST answer null for a turn in another environment rather
   * than returning it: the use case turns null into
   * `GOVERNANCE_RATING_TARGET_NOT_FOUND`, and a cross-tenant probe must be
   * indistinguishable from a typo.
   */
  find(scope: EnvironmentScope, turnId: TurnId): Promise<Result<RatingTarget | null>>;
}

/** A conversation, as the judge is shown it. */
export interface Transcript {
  readonly threadId: ThreadId;
  readonly agentId: AgentId;
  /** In conversation order. A cancelled turn is not included. */
  readonly turns: readonly TranscriptTurn[];
}

export interface TranscriptReader {
  /**
   * Read one thread's transcript, or null when it is not in this environment.
   *
   * `turnId` narrows to a single exchange — the source's "sample one message
   * rather than the whole thread" path. A named turn that is not in the thread
   * yields an EMPTY turn list rather than the whole thread, so a mistyped id
   * cannot silently widen what a judge is paid to read.
   */
  read(scope: EnvironmentScope, threadId: ThreadId, turnId: TurnId | null): Promise<Result<Transcript | null>>;
}

/** The denominators the risk score divides by. Owned by three other contexts. */
export interface AgentActivityCounts {
  readonly agentId: AgentId;
  readonly turns: number;
  readonly toolErrors: number;
  readonly approvalEvents: number;
}

export interface ActivityReader {
  /** Per-agent counts inside the window, for every agent that did anything. */
  countByAgent(scope: EnvironmentScope, since: Date): Promise<Result<readonly AgentActivityCounts[]>>;
}
