// The `AgentVersionLock` port — thread stickiness for a canary split.
//
// A canary is a per-turn coin flip. Left alone, that means a single conversation
// can be answered by the canary version, then the active one, then the canary
// again — three different system prompts and three different tool sets inside
// one thread, which is indistinguishable from an agent behaving erratically.
//
// So the first turn on a thread WINS the version for that thread, and every
// later turn follows it. The mechanism is a short-lived, first-writer-wins hold
// keyed by the thread: the winner's version id is what everyone reads.
//
// THE PORT RETURNS THE WINNER, NOT WHETHER YOU WON. `hold` answers with the
// version id that is now in force — the caller's own when it won the race, and
// somebody else's when it lost. A boolean would make every caller do a second
// read to find out what it must actually serve, and a caller that forgot would
// serve the version it picked rather than the version the thread is on. That is
// the whole bug this port exists to make unwritable.
//
// ADR M0.3 §13 makes an adapter-facing port the property of the context whose
// capability it serves. Version selection is this context's rule (see
// `domain/binding.ts`), so the lock is this context's port; the store behind it
// is an implementation detail that does not define ownership.

import type { EnvironmentScope, Result } from "@platos/kernel";

import type { AgentId, AgentVersionId } from "../../domain/index.js";

/** Which conversation a hold is keyed by. Opaque here: `conversations` owns it. */
export interface ThreadKey {
  readonly scope: EnvironmentScope;
  readonly agentId: AgentId;
  readonly threadId: string;
}

export interface AgentVersionLock {
  /** The version already in force for this thread, or null when none is. */
  read(key: ThreadKey): Promise<Result<AgentVersionId | null>>;

  /**
   * Claim `versionId` for this thread, and answer with whichever claim won.
   *
   * First writer wins and the hold is never overwritten, so a later turn cannot
   * move a thread onto a different version by racing.
   */
  hold(key: ThreadKey, versionId: AgentVersionId): Promise<Result<AgentVersionId>>;

  /**
   * Release every hold for one agent in one environment.
   *
   * Called when a save mints a version: threads in flight keep serving the
   * version they were answered by until their hold lapses, and new threads pick
   * up the new one. Releasing is what makes a rollback take effect promptly
   * instead of on the hold's own timetable.
   */
  releaseAll(scope: EnvironmentScope, agentId: AgentId): Promise<Result<void>>;
}
