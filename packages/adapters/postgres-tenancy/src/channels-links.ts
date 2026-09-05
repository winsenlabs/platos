// `ChannelThread` and `ChannelAppThread` — two tables, one link.
//
// THE UNION IS THE ROUTING, AND IT IS TOTAL. `domain/thread-link.ts` models the
// owner as a discriminated union rather than two nullable columns so that "which
// kind of link is this?" is a compile-time question, and the two tables here are
// what that union is a union OF. A `connection` owner reads and writes
// `ChannelThread`, an `installation` owner `ChannelAppThread`, and neither table
// can hold the other's row: the owner column is a foreign key into a different
// table in each.
//
// THE INSERT FAILS ON THE UNIQUE RATHER THAN OVERWRITING, and the port explains
// why in one sentence: "the unique IS the concurrency control here: two workers
// racing the same first message must produce one link, and an upsert would
// silently let the second win". The consequence for a conversation is worse than
// a lost write — re-pointing an existing key at a different thread splits one
// human conversation across two transcripts and the agent loses every turn
// before the split.
//
// THE CONFLICTING THREAD IS READ BEFORE THE INSERT, NOT AFTER IT, AND THAT COST
// AN INTEGRATION RUN TO LEARN. The refusal has to name the thread the key is
// ALREADY linked to — `threadLinkConflict(key, existing.threadId, requested)` is
// what the in-memory double reports and the two transcripts are compared
// verbatim — so the first version read the winner back inside the `catch`. It
// cannot: a constraint violation puts the whole PostgreSQL transaction into the
// aborted state, and every statement after it is refused with 25P02 until the
// transaction ends. The read came back as `PrismaClientUnknownRequestError` and
// the refusal named the driver rather than the conflict.
//
// SO THE PROBE IS FIRST AND THE INSERT IS STILL THE ARBITER. A key already
// linked is answered from the probe, with the winner's thread named exactly as
// the double names it. A key that was free at the probe and taken by the time
// the INSERT ran is a genuine concurrent race, and its refusal is a DIFFERENT
// code — `thread_link_race_lost` — because the truthful `linkedThreadId` is
// unobtainable from inside a transaction the database has already aborted. That
// is a clause of the port's contract the real database cannot honour, and it is
// pinned as a named case rather than filled in with a plausible id.
//
// THE CALLER DOES NOT NEED IT ANYWAY, and that is checkable rather than assumed:
// `dispatch-inbound-turn.ts::resolveLink` re-reads through `findThreadLink`
// AFTER `unitOfWork.run` has returned — on a connection with no aborted
// transaction on it — and treats the winner's link as the truth. The refusal
// this store returns is the signal to do that, not the data it acts on.
//
// `findThreadLinksByThread` READS BOTH TABLES, ALWAYS, and that is the erasure
// path's requirement rather than a convenience: `channels-erasure-target.ts`
// keys on the THREAD, and a subject's conversation may have arrived through a
// direct connection or through a hosted installation. Two statements, flat in
// the number of links, because neither is a per-row query.

import type {
  ChannelThreadKey,
  ChannelThreadLink,
  Result,
  ThreadId,
  ThreadLinkOwner,
  TransactionScope,
} from "@platos/context-channels/application/ports/index.js";
import {
  err,
  ok,
  repositoryUnavailable,
  threadLinkConflict,
} from "@platos/context-channels/application/ports/index.js";

import { isUniqueViolation } from "./client.js";
import type { LinkRow } from "./channels-rows.js";
import { readLinkRow } from "./channels-rows.js";
import { firstRefusal, guarded, requireThreadKey, requireUuid } from "./channels-guards.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The key was free at the probe and taken by the time the INSERT ran.
 *
 * DISTINCT from `CHANNELS_THREAD_LINK_CONFLICT` on purpose. That error names the
 * thread the key is linked to; this one cannot, because the statement that would
 * read it is refused by a transaction the failed INSERT has already aborted. Two
 * guards sharing one code cannot be told apart, and here the difference is
 * exactly whether the caller has been told which thread won.
 */
export const THREAD_LINK_RACE_LOST = "thread_link_race_lost";

/** The owner row's id, whichever half of the union this is. */
function ownerId(owner: ThreadLinkOwner): string {
  return owner.kind === "connection" ? owner.connectionId : owner.installationId;
}

export interface ChannelThreadLinkStore {
  findThreadLink(
    owner: ThreadLinkOwner,
    channelThreadKey: ChannelThreadKey,
  ): Promise<Result<ChannelThreadLink | null>>;
  insertThreadLink(
    link: ChannelThreadLink,
    transaction: TransactionScope,
  ): Promise<Result<ChannelThreadLink>>;
  findThreadLinksByThread(threadId: ThreadId): Promise<Result<readonly ChannelThreadLink[]>>;
}

export function createChannelThreadLinkStore(
  transactions: TenancyTransactions,
): ChannelThreadLinkStore {
  async function readConnectionLink(
    connectionId: string,
    channelThreadKey: string,
  ): Promise<LinkRow | null> {
    const row = await transactions.reader().channelThread.findUnique({
      where: { connectionId_channelThreadKey: { connectionId, channelThreadKey } },
      select: { id: true, connectionId: true, threadId: true, channelThreadKey: true, createdAt: true },
    });
    return row === null ? null : { ...row, ownerId: row.connectionId };
  }

  async function readInstallationLink(
    installationId: string,
    channelThreadKey: string,
  ): Promise<LinkRow | null> {
    const row = await transactions.reader().channelAppThread.findUnique({
      where: { installationId_channelThreadKey: { installationId, channelThreadKey } },
      select: {
        id: true,
        installationId: true,
        threadId: true,
        channelThreadKey: true,
        createdAt: true,
      },
    });
    return row === null ? null : { ...row, ownerId: row.installationId };
  }

  function load(owner: ThreadLinkOwner, channelThreadKey: string): Promise<LinkRow | null> {
    return owner.kind === "connection"
      ? readConnectionLink(owner.connectionId, channelThreadKey)
      : readInstallationLink(owner.installationId, channelThreadKey);
  }

  return {
    async findThreadLink(owner, channelThreadKey) {
      const operation = "findThreadLink";
      const checked = firstRefusal(null as ChannelThreadLink | null, [
        requireUuid<ChannelThreadLink | null>(operation, "ownerId", ownerId(owner)),
        requireThreadKey<ChannelThreadLink | null>(operation, channelThreadKey),
      ]);
      if (!checked.ok) return checked;
      return guarded(operation, async () => {
        const row = await load(owner, channelThreadKey);
        return ok(row === null ? null : readLinkRow(row, owner.kind));
      });
    },

    async insertThreadLink(link, transaction) {
      const operation = "insertThreadLink";
      const checked = firstRefusal(link, [
        requireUuid<ChannelThreadLink>(operation, "linkId", link.linkId),
        requireUuid<ChannelThreadLink>(operation, "ownerId", ownerId(link.owner)),
        requireUuid<ChannelThreadLink>(operation, "threadId", link.threadId),
        requireThreadKey<ChannelThreadLink>(operation, link.channelThreadKey),
      ]);
      if (!checked.ok) return checked;
      return guarded(operation, async () => {
        // THE PROBE, inside the same transaction, so it sees this transaction's
        // own uncommitted links. `reader()` prefers the ambient frame precisely
        // so a read between two writes of one transaction is not answered from
        // outside it.
        const already = await load(link.owner, link.channelThreadKey);
        if (already !== null) {
          return err(
            threadLinkConflict(link.channelThreadKey, already.threadId, link.threadId),
          );
        }
        try {
          const writer = transactions.writer(transaction);
          if (link.owner.kind === "connection") {
            await writer.channelThread.create({
              data: {
                id: link.linkId,
                connectionId: link.owner.connectionId,
                threadId: link.threadId,
                channelThreadKey: link.channelThreadKey,
                createdAt: link.createdAt,
              },
              select: { id: true },
            });
          } else {
            await writer.channelAppThread.create({
              data: {
                id: link.linkId,
                installationId: link.owner.installationId,
                threadId: link.threadId,
                channelThreadKey: link.channelThreadKey,
                createdAt: link.createdAt,
              },
              select: { id: true },
            });
          }
          return ok(link);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // NOTHING IS READ HERE. See the header: the transaction is aborted and
          // the only statement that could name the winner is refused. The caller
          // re-reads on a clean connection.
          return err(
            repositoryUnavailable(`${operation}:${THREAD_LINK_RACE_LOST}:${link.channelThreadKey}`),
          );
        }
      });
    },

    async findThreadLinksByThread(threadId) {
      const operation = "findThreadLinksByThread";
      const malformed = requireUuid<readonly ChannelThreadLink[]>(operation, "threadId", threadId);
      if (malformed !== null) return malformed;
      return guarded(operation, async () => {
        const direct = await transactions.reader().channelThread.findMany({
          where: { threadId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            connectionId: true,
            threadId: true,
            channelThreadKey: true,
            createdAt: true,
          },
        });
        const hosted = await transactions.reader().channelAppThread.findMany({
          where: { threadId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            installationId: true,
            threadId: true,
            channelThreadKey: true,
            createdAt: true,
          },
        });
        return ok([
          ...direct.map((row) => readLinkRow({ ...row, ownerId: row.connectionId }, "connection")),
          ...hosted.map((row) =>
            readLinkRow({ ...row, ownerId: row.installationId }, "installation"),
          ),
        ]);
      });
    },
  };
}
