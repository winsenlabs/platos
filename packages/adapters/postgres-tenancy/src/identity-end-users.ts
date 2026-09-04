// `EndUserStore` and `ImpersonationAuditStore` — the one paginated read in this
// port, and the one append-only table.
//
// THE TENANT CLAUSE IS FIRST AND IS NOT OPTIONAL. `organizationId` is not one of
// the filters: a row from another organization is not a row that failed a
// filter, it is a row this caller must never see. The domain says the same thing
// in `matchesEndUserQuery`, and the two statements are deliberately both there —
// a store that leaked would then be a FAILING TEST rather than a breach, because
// the conformance run compares this store's answers against a fake that applies
// the domain predicate.
//
// `count` TAKES THE SAME QUERY AS `list`, MINUS PAGING. A total computed under
// different filtering from the page it describes is a pagination control that
// lies: the caller sees "showing 25 of 900" and pages into an empty set.
//
// NO N+1. The identities are loaded through ONE nested selection, so a page of
// twenty-five end users costs the same number of statements as a page of one.
// `identity-statements.integration.test.ts` pins both and would go red on a
// per-row identity fetch — which is the shape this store would have taken if the
// mapping were written row by row.
//
// SEARCH IS CASE-INSENSITIVE ON TWO COLUMNS. `displayName` on the end user and
// `subject` on any of its identities, matching the domain predicate exactly. A
// store that searched only the name would answer differently from the fake for
// every operator looking somebody up by their channel handle, which is what an
// operator actually has.

import type {
  EndUserQuery,
  EndUserWithIdentities,
  ImpersonationAuditEntry,
} from "@platos/context-identity-access/application/ports/index.js";
import type {
  EndUserStore,
  ImpersonationAuditStore,
} from "@platos/context-identity-access/application/ports/index.js";

import { toEndUserIdentityRecord, toEndUserRecord } from "./identity-rows.js";
import type { TenancyTransactions } from "./transaction.js";

const IDENTITY_COLUMNS = {
  id: true,
  endUserId: true,
  issuer: true,
  channel: true,
  subject: true,
  verifiedAt: true,
  disabledAt: true,
} as const;

interface EndUserFilter {
  readonly organizationId: string;
  disabledAt?: null | { not: null };
  OR?: readonly unknown[];
}

/**
 * The WHERE clause, built once and shared by `list` and `count`.
 *
 * Sharing it is the mechanism, not a tidiness preference: two independently
 * written clauses are two clauses that can drift, and the drift is invisible
 * until a caller notices a total that does not match the pages under it.
 */
function filterFor(query: EndUserQuery): EndUserFilter {
  const filter: EndUserFilter = { organizationId: query.organizationId };
  if (query.status === "active") filter.disabledAt = null;
  if (query.status === "disabled") filter.disabledAt = { not: null };
  if (query.search !== null) {
    filter.OR = [
      { displayName: { contains: query.search, mode: "insensitive" } },
      { identities: { some: { subject: { contains: query.search, mode: "insensitive" } } } },
    ];
  }
  return filter;
}

export function createEndUserStore(transactions: TenancyTransactions): EndUserStore {
  return {
    async list(query: EndUserQuery): Promise<readonly EndUserWithIdentities[]> {
      const rows = await transactions.reader().endUser.findMany({
        where: filterFor(query),
        select: {
          id: true,
          organizationId: true,
          displayName: true,
          disabledAt: true,
          createdAt: true,
          identities: { select: IDENTITY_COLUMNS },
        },
        // `id` descending is the tiebreak, not decoration. Rows created in the
        // same millisecond would otherwise come back in an unstable order and a
        // caller walking pages would see one row twice and another never.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: query.offset,
        take: query.limit,
      });
      return rows.map((row) => ({
        user: toEndUserRecord(row),
        // The identities are NOT re-filtered by the search term. A user matched
        // by one of their identities still owns all of them, and returning only
        // the matching one would make the answer depend on how it was found.
        identities: row.identities.map((identity) =>
          toEndUserIdentityRecord(identity, row.id),
        ),
      }));
    },

    async count(query: EndUserQuery): Promise<number> {
      return transactions.reader().endUser.count({ where: filterFor(query) });
    },
  };
}

export function createImpersonationAuditStore(
  transactions: TenancyTransactions,
): ImpersonationAuditStore {
  return {
    async append(entry: ImpersonationAuditEntry): Promise<void> {
      // `create` and nothing else. The table is append-only in the database as
      // well: the migrations install BEFORE UPDATE, BEFORE DELETE and BEFORE
      // TRUNCATE rules that raise, and REVOKE the three privileges from PUBLIC.
      // So an `update` here would not merely be wrong by convention, it would
      // fail — which is the property `identity-constraints.integration.test.ts`
      // asserts rather than assumes.
      await transactions.reader().impersonationAudit.create({
        data: {
          action: entry.action,
          actorUserId: entry.actorUserId,
          targetUserId: entry.targetUserId,
          impersonationSessionId: entry.impersonationSessionId,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
          createdAt: entry.recordedAt,
        },
      });
    },
  };
}
