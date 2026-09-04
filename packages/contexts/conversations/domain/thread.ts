// `Thread` — the conversation, and the row this context is sole writer of.
//
// A THREAD IS ONE END USER TALKING TO ONE AGENT. Both foreign keys are required
// in the schema and neither is nullable, so there is no such thing here as an
// anonymous thread or an agentless one. `endUser` cascades and `agent` restricts,
// which is the schema saying what this file says in code: erasing an end user
// takes their threads, and an agent cannot be deleted while a thread names it.
//
// THE THREE THINGS THAT ARE NOT SIMPLY COLUMNS.
//
//   FORKING. `parentThreadId`, `forkedUpToTurnId` and `forkedTurnIds` together
//   record a thread that was branched from another at a point. The array exists
//   because the alternative — copying the ancestor turns into the fork — would
//   duplicate BILLABLE LEDGER ROWS, and the schema comment says so. So a fork
//   REFERENCES its ancestry and `transcript.ts` reads through it.
//
//   COMPACTION. `compactionState`, `compactedUpToTurnId`, `compactedAt` and
//   `summary` are a small state machine over a long conversation: once a prefix
//   has been summarised, later prompts carry the summary instead of the turns.
//   `thread-compaction.ts` owns the machine; this file owns the row it moves.
//
//   THE SESSION CONTEXT. `sessionContext` is documented as an OBJECT ROOT
//   carrying "verified, non-authoritative channel context". Both adjectives are
//   load-bearing and both are enforced here: verified, so a transport puts only
//   what it authenticated in it; non-authoritative, so nothing in this package
//   makes an authorization decision from it. It reaches a prompt and nothing
//   else.
//
// A THREAD SETTLES, AND A SETTLED THREAD TAKES NO MORE TURNS. `status` is the
// same `WorkStatus` a turn uses, and `archivedAt` is the separate, softer state:
// an archived thread is readable and refuses writes, which is why it has its own
// code rather than sharing the settled one.

import { err, ok, type JsonValue, type Result } from "@platos/kernel";

import {
  sessionContextInvalid,
  sessionContextTooLarge,
  threadArchived,
  threadTagsInvalid,
  threadTitleInvalid,
} from "./errors.js";
import type { AgentId, ClusterId, EndUserId, ThreadId, TurnId } from "./identifiers.js";
import type { ThreadPolicy } from "./policy.js";
import type { WorkStatus } from "./work-status.js";

export const THREAD_COMPACTION_STATES = ["IDLE", "IN_PROGRESS"] as const;

export type ThreadCompactionState = (typeof THREAD_COMPACTION_STATES)[number];

/** An object root, exactly as the column's own comment requires. */
export type SessionContext = Readonly<Record<string, JsonValue>>;

export interface Thread {
  readonly threadId: ThreadId;
  readonly agentId: AgentId;
  readonly endUserId: EndUserId;
  readonly clusterId: ClusterId | null;
  readonly parentThreadId: ThreadId | null;
  readonly forkedUpToTurnId: TurnId | null;
  /** Ancestor turns, in order. References, never copies: see the header. */
  readonly forkedTurnIds: readonly TurnId[];
  readonly compactedUpToTurnId: TurnId | null;
  readonly title: string | null;
  readonly status: WorkStatus;
  readonly summary: string | null;
  readonly compactionState: ThreadCompactionState;
  readonly compactedAt: Date | null;
  readonly sessionContext: SessionContext | null;
  readonly tags: readonly string[];
  readonly pinnedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ThreadDraft {
  readonly threadId: ThreadId;
  readonly agentId: AgentId;
  readonly endUserId: EndUserId;
  readonly clusterId?: ClusterId | null;
  readonly title?: string | null;
  readonly tags?: readonly string[];
  readonly sessionContext?: SessionContext | null;
  readonly at: Date;
}

function admitTitle(title: string | null | undefined, policy: ThreadPolicy): Result<string | null> {
  if (title === null || title === undefined) return ok(null);
  const trimmed = title.trim();
  if (trimmed === "") {
    const message = "a title that is present must not be blank";
    return err(threadTitleInvalid([{ field: "title", code: "BLANK", message }]));
  }
  if (trimmed.length > policy.maxTitleLength) {
    const message = `a title may be at most ${policy.maxTitleLength} characters`;
    return err(threadTitleInvalid([{ field: "title", code: "TOO_LONG", message }]));
  }
  return ok(trimmed);
}

function admitTags(tags: readonly string[] | undefined, policy: ThreadPolicy): Result<readonly string[]> {
  const given = tags ?? [];
  if (given.length > policy.maxTags) {
    const message = `a thread may carry at most ${policy.maxTags} tags`;
    return err(threadTagsInvalid([{ field: "tags", code: "TOO_MANY", message }]));
  }
  for (const [index, tag] of given.entries()) {
    if (tag.trim() === "") {
      const message = "a tag must not be blank";
      return err(threadTagsInvalid([{ field: `tags[${index}]`, code: "BLANK", message }]));
    }
    if (tag.length > policy.maxTagLength) {
      const message = `a tag may be at most ${policy.maxTagLength} characters`;
      return err(threadTagsInvalid([{ field: `tags[${index}]`, code: "TOO_LONG", message }]));
    }
  }
  return ok(Object.freeze([...given]));
}

/**
 * Admit a session context, or refuse it.
 *
 * TWO CODES, BECAUSE THERE ARE TWO DECISIONS. A non-object root is a shape the
 * column's own registry cannot validate and no reader can interpret; an
 * over-large object is well formed and simply too big to carry into every
 * prompt this thread ever builds. The remedies differ, so the codes do.
 */
export function admitSessionContext(
  context: SessionContext | null | undefined,
  policy: ThreadPolicy,
): Result<SessionContext | null> {
  if (context === null || context === undefined) return ok(null);
  if (Array.isArray(context) || typeof context !== "object") {
    return err(sessionContextInvalid("session context must be a JSON object at its root"));
  }
  const bytes = JSON.stringify(context).length;
  if (bytes > policy.maxSessionContextBytes) {
    return err(sessionContextTooLarge(bytes, policy.maxSessionContextBytes));
  }
  return ok(Object.freeze({ ...context }));
}

/** Open a thread. It starts ACTIVE, IDLE, unpinned and unarchived. */
export function openThread(draft: ThreadDraft, policy: ThreadPolicy): Result<Thread> {
  const title = admitTitle(draft.title, policy);
  if (!title.ok) return err(title.error);
  const tags = admitTags(draft.tags, policy);
  if (!tags.ok) return err(tags.error);
  const context = admitSessionContext(draft.sessionContext, policy);
  if (!context.ok) return err(context.error);

  return ok(
    Object.freeze({
      threadId: draft.threadId,
      agentId: draft.agentId,
      endUserId: draft.endUserId,
      clusterId: draft.clusterId ?? null,
      parentThreadId: null,
      forkedUpToTurnId: null,
      forkedTurnIds: Object.freeze([]),
      compactedUpToTurnId: null,
      title: title.value,
      status: "ACTIVE" as WorkStatus,
      summary: null,
      compactionState: "IDLE" as ThreadCompactionState,
      compactedAt: null,
      sessionContext: context.value,
      tags: tags.value,
      pinnedAt: null,
      archivedAt: null,
      createdAt: draft.at,
      updatedAt: draft.at,
    }),
  );
}

/**
 * Refuse a write to a thread that will not take one.
 *
 * Archived FIRST, because an archived thread is the case an operator can undo
 * and the one whose message should say so. A settled thread is refused by the
 * transition table when the turn is appended.
 */
export function requireWritable(thread: Thread): Result<Thread> {
  if (thread.archivedAt !== null) return err(threadArchived(thread.threadId));
  return ok(thread);
}

/** True when this end user is the thread's subject. Ownership, not authorization. */
export function isOwnedBy(thread: Thread, endUserId: EndUserId): boolean {
  return thread.endUserId === endUserId;
}
