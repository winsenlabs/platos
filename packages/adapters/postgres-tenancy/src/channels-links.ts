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
// THE COLLISION COSTS A SECOND STATEMENT AND THE FRESH PATH DOES NOT. The
// refusal has to name the thread the key is ALREADY linked to — the in-memory
// double reports `threadLinkConflict(key, existing.threadId, requested)` and the
// two transcripts are compared verbatim — and the row that lost the race is the
// only place that id exists. So a lost race reads the winner back. A read on
// every insert would have made the ordinary path two statements to save one on
// the rare one.
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
import { err, ok, threadLinkConflict } from "@platos/context-channels/application/ports/index.js";

import { isUniqueViolation } from "./client.js";
import type { LinkRow } from "./channels-rows.js";
import { readLinkRow } from "./channels-rows.js";
import { firstRefusal, guarded, requireThreadKey, requireUuid } from "./channels-guards.js";
import type { TenancyTransactions } from "./transaction.js";

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
          const existing = await load(link.owner, link.channelThreadKey);
          // The winner is read back INSIDE the same transaction, so the id
          // reported is the one this transaction will see afterwards. Reading it
          // outside would be a second snapshot and could name a row that has
          // since been rolled back.
          return err(
            threadLinkConflict(
              link.channelThreadKey,
              existing?.threadId ?? link.threadId,
              link.threadId,
            ),
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
