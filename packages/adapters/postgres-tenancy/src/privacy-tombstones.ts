// `TombstoneRepository` — the erased-subject register, which is the write
// barrier every identity chokepoint consults.
//
// READ-TIME EXPIRY IS IN THE `where`, AND IT IS `isActive`'s EXACT COMPLEMENT.
// The port says "a row past its `expiresAt` MUST NOT be returned even when it is
// still in the table". `isActive` is STRICTLY greater than `now`, so the
// predicate is `expiresAt > now`; `hasElapsed` is its complement, so the purge is
// `expiresAt <= now`. Written as one pair here so the read rule and the sweep
// rule cannot disagree about the boundary instant — which is a tick nothing else
// in this system would ever exercise. `privacy-rules.integration.test.ts` pins
// both sides of it against the real column.
//
// SEALING IS INSERT-THEN-EXTEND, NEVER DELETE-THEN-INSERT, AND THE STATEMENTS
// SAY SO. There is no DELETE in this file except `purgeExpiredTombstones`, whose
// own predicate cannot match a live row. The port's reason is exact: "A re-seal
// on retry must not leave the barrier momentarily open, and a delete-then-insert
// does exactly that for the width of its own transaction" — and the transaction
// in question is the one `seal-subject.ts` opens BEFORE the destructive pass, so
// the window would be open precisely while the targets are deleting.
//
// AND IT IS THREE STATEMENTS FOR THREE ALIASES OR FOR THREE HUNDRED. A seal is a
// scoped read, one `createMany` and one `updateMany`, and the count does not move
// with the size of the alias set. That matters more here than anywhere else in
// this directory: an alias set is one per identity channel the person was ever
// reachable on, and a per-alias upsert loop would put the erasure's own barrier
// on an O(aliases) round trip inside the transaction that is holding the
// destruction open.
//
// `createMany` CARRIES `skipDuplicates`, WHICH IS `ON CONFLICT DO NOTHING`, AND
// THAT IS BELT AND BRACES RATHER THAN THE MECHANISM. The split is already decided
// by the scoped read above it; the clause is what keeps a concurrent seal of the
// SAME subject — a queue resume racing an operator retry — from aborting the
// caller's transaction on `ErasureTombstone_organizationId_aliasHash_key`. Losing
// that race must not open the barrier, and with the clause it does not: the row
// is there either way.

import type {
  AliasHash,
  ErasureTombstone,
  ErasureTombstoneId,
  OrganizationId,
  Result,
  TombstoneDraft,
  TombstoneRepository,
  TransactionScope,
} from "@platos/context-privacy/application/ports/index.js";
import { ok } from "@platos/context-privacy/application/ports/index.js";

import { guardSealBatch, requireInstant, requireUuid } from "./privacy-guards.js";
import { refuseRegister } from "./privacy-refusal.js";
import { readTombstoneRow, TOMBSTONE_COLUMNS, type TombstoneRow } from "./privacy-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** One row bound for `createMany`, paired with the id the use case minted. */
interface SealRow {
  readonly id: string;
  readonly organizationId: string;
  readonly aliasHash: string;
  readonly operationId: string;
  readonly policyVersion: string;
  readonly sealedAt: Date;
  readonly expiresAt: Date;
}

/**
 * The extend half, grouped by the values an UPDATE would set.
 *
 * `draftTombstones` gives every draft in one seal the same expiry, operation and
 * policy version, so this map has ONE entry in every reachable case and the
 * extend is one statement. It is a map rather than an assumption because the port
 * takes `readonly TombstoneDraft[]` and each draft carries its own three values:
 * a caller that assembled a mixed batch would otherwise have had the LAST draft's
 * expiry silently applied to every alias in it.
 */
function extendGroups(
  drafts: readonly TombstoneDraft[],
): Map<string, { readonly draft: TombstoneDraft; readonly aliasHashes: string[] }> {
  const groups = new Map<string, { draft: TombstoneDraft; aliasHashes: string[] }>();
  for (const draft of drafts) {
    const key = `${String(draft.expiresAt.getTime())}/${draft.operationId}/${draft.policyVersion}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { draft, aliasHashes: [draft.aliasHash] });
    else group.aliasHashes.push(draft.aliasHash);
  }
  return groups;
}

export function createPrivacyTombstoneStore(
  transactions: TenancyTransactions,
): TombstoneRepository {
  return {
    async findActiveTombstones(
      organizationId: OrganizationId,
      aliasHashes: readonly AliasHash[],
      now: Date,
    ): Promise<Result<readonly ErasureTombstone[]>> {
      return refuseRegister(async () => {
        requireUuid("ErasureTombstone.organizationId", organizationId);
        requireInstant("findActiveTombstones.now", now);
        // An empty alias set is answered without a statement. It is not an edge
        // case: `guard-subject-write.ts` returns early on it, and every OTHER
        // caller of this port on the hot path would otherwise send
        // `aliasHash IN ()` on every anonymous request in the system.
        if (aliasHashes.length === 0) return ok([]);
        const rows = (await transactions.reader().erasureTombstone.findMany({
          where: {
            organizationId,
            aliasHash: { in: [...aliasHashes] },
            // `isActive` is `expiresAt.getTime() > now.getTime()`. See the header.
            expiresAt: { gt: now },
          },
          select: TOMBSTONE_COLUMNS,
        })) as TombstoneRow[];
        return ok(rows.map(readTombstoneRow));
      }, "findActiveTombstones");
    },

    async sealTombstones(
      drafts: readonly TombstoneDraft[],
      ids: readonly ErasureTombstoneId[],
      transaction: TransactionScope,
    ): Promise<Result<{ readonly sealed: number; readonly extended: number }>> {
      return refuseRegister(async () => {
        // An empty seal is `{ sealed: 0, extended: 0 }` and NOT an error, which
        // is what the double answers. `SealOutcome`'s own comment says a seal
        // reporting both at zero means the alias set was empty and is "a
        // different fact worth failing on" — that judgement belongs to
        // `seal-subject.ts`, which holds the alias count; a store that refused
        // here would be making it on the caller's behalf with less information.
        if (drafts.length === 0) return ok({ sealed: 0, extended: 0 });
        const organizationId = guardSealBatch(drafts, ids);
        const writer = transactions.writer(transaction);

        // The split, in ONE scoped read. It joins the caller's transaction
        // through the ambient frame, so a seal that ran after another write in
        // the same unit of work sees that write.
        const present = (await writer.erasureTombstone.findMany({
          where: { organizationId, aliasHash: { in: drafts.map((draft) => draft.aliasHash) } },
          select: { aliasHash: true },
        })) as readonly { readonly aliasHash: string }[];
        const existing = new Set(present.map((row) => row.aliasHash));

        const inserts: SealRow[] = [];
        const extends_: TombstoneDraft[] = [];
        // `seen` mirrors `draftTombstones`, which drops a repeated alias: two
        // rows for one `(organizationId, aliasHash)` in ONE `createMany` would
        // otherwise be one insert and one silent skip, and the reported `sealed`
        // would disagree with the batch the caller passed.
        const seen = new Set<string>();
        for (const [index, draft] of drafts.entries()) {
          if (seen.has(draft.aliasHash)) continue;
          seen.add(draft.aliasHash);
          if (existing.has(draft.aliasHash)) {
            extends_.push(draft);
            continue;
          }
          const id = ids[index];
          if (id === undefined) continue;
          inserts.push({ id, ...draft });
        }

        let sealed = 0;
        if (inserts.length > 0) {
          const written = await writer.erasureTombstone.createMany({
            data: inserts,
            skipDuplicates: true,
          });
          sealed = written.count;
        }

        let extended = 0;
        for (const group of extendGroups(extends_).values()) {
          const moved = await writer.erasureTombstone.updateMany({
            where: { organizationId, aliasHash: { in: group.aliasHashes } },
            data: {
              expiresAt: group.draft.expiresAt,
              operationId: group.draft.operationId,
              policyVersion: group.draft.policyVersion,
            },
          });
          extended += moved.count;
        }
        return ok({ sealed, extended });
      }, "sealTombstones");
    },

    async purgeExpiredTombstones(now: Date, transaction: TransactionScope): Promise<Result<number>> {
      return refuseRegister(async () => {
        requireInstant("purgeExpiredTombstones.now", now);
        // NOT organization-scoped, and the port takes no organization to scope it
        // by: this is the installation-wide retention sweep, and every row it can
        // match has already stopped refusing writes. `hasElapsed` is
        // `!(expiresAt > now)`, so the predicate is `expiresAt <= now`.
        const purged = await transactions.writer(transaction).erasureTombstone.deleteMany({
          where: { expiresAt: { lte: now } },
        });
        return ok(purged.count);
      }, "purgeExpiredTombstones");
    },
  };
}
