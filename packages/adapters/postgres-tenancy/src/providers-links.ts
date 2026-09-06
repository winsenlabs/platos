// The `EnvironmentProvider` half of `ProvidersRepository` — an environment's
// adoption of a provider, and the smallest of the four rows.
//
// ONE UNIQUE INDEX AND NOTHING ELSE. `@@unique([environmentId, providerId])` is
// the whole of this table's law: adopting a provider twice is the same adoption,
// as `domain/provider-link.ts` puts it. There is no trigger, no CHECK and no
// ancestry rule over it, which is worth stating rather than leaving as an
// absence — every other row in this tranche carries at least one.
//
// SO THE UPSERT IS A REAL UPSERT. `upsertProviderLink` is the only method in
// this store that could have raced with itself, and the unique tuple it races on
// is exactly the one the driver's `upsert` targets, so `ON CONFLICT … DO UPDATE`
// resolves it in one statement rather than in a read followed by a decision.
//
// THE ROW ID IS THE CALLER'S ON INSERT AND THE STORE'S ON UPDATE, which is what
// `ProviderLink.environmentProviderId` means and what the double cannot show:
// its map is keyed by `${environmentId}/${provider}` and it OVERWRITES the id
// with whatever the caller passed. A second adoption of one provider therefore
// changes the row's identity in the double and does not in the database — and
// the conformance run compares the returned link, so the store answers with what
// the row now holds rather than with what it was handed.

import type {
  EnvironmentScope,
  ProviderId,
  ProviderLink,
  Result,
  TransactionScope,
} from "@platos/context-providers/application/ports/index.js";
import { ok } from "@platos/context-providers/application/ports/index.js";

import { readProviderLink, writeProviderLink, type ProviderLinkRow } from "./providers-rows.js";
import type { TenancyTransactions } from "./transaction.js";

const LINK_COLUMNS = {
  id: true,
  environmentId: true,
  providerId: true,
  enabled: true,
  linkedAt: true,
  updatedAt: true,
} as const;

/** The ancestry predicate, spelled here for the reason `providers-keys.ts` gives. */
function scopedWhere(scope: EnvironmentScope): {
  readonly environmentId: string;
  readonly environment: {
    readonly projectId: string;
    readonly project: { readonly organizationId: string };
  };
} {
  return {
    environmentId: scope.environmentId,
    environment: {
      projectId: scope.projectId,
      project: { organizationId: scope.organizationId },
    },
  };
}

export interface ProviderLinkStore {
  listProviderLinks(scope: EnvironmentScope): Promise<Result<readonly ProviderLink[]>>;
  findProviderLink(scope: EnvironmentScope, provider: ProviderId): Promise<Result<ProviderLink | null>>;
  upsertProviderLink(link: ProviderLink, transaction: TransactionScope): Promise<Result<ProviderLink>>;
  deleteProviderLink(
    scope: EnvironmentScope,
    provider: ProviderId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;
}

export function createProviderLinkStore(transactions: TenancyTransactions): ProviderLinkStore {
  return {
    async listProviderLinks(scope: EnvironmentScope): Promise<Result<readonly ProviderLink[]>> {
      // ORDERED, though the port does not ask for an order. An unordered read is
      // an order the planner picks, and `describe-providers.ts` renders this
      // list beside the manifest catalogue: a page whose rows move between
      // loads is a page an operator cannot read. `providerId` is total here
      // because the unique index makes it unique within the scope.
      const rows = await transactions.reader().environmentProvider.findMany({
        where: scopedWhere(scope),
        select: LINK_COLUMNS,
        orderBy: { providerId: "asc" },
      });
      return ok(rows.map((row: ProviderLinkRow) => readProviderLink(row)));
    },

    async findProviderLink(
      scope: EnvironmentScope,
      provider: ProviderId,
    ): Promise<Result<ProviderLink | null>> {
      // `findFirst` with the whole ancestry, not `findUnique` on the pair. The
      // double compares `environmentId` alone; an adoption in another tenant's
      // environment must be ABSENT here rather than read and then discarded.
      const row = await transactions.reader().environmentProvider.findFirst({
        where: { providerId: provider, ...scopedWhere(scope) },
        select: LINK_COLUMNS,
      });
      return ok(row === null ? null : readProviderLink(row));
    },

    async upsertProviderLink(
      link: ProviderLink,
      transaction: TransactionScope,
    ): Promise<Result<ProviderLink>> {
      const client = transactions.writer(transaction);
      const row = writeProviderLink(link);
      const written = await client.environmentProvider.upsert({
        where: {
          environmentId_providerId: { environmentId: row.environmentId, providerId: row.providerId },
        },
        create: row,
        // `id` and `linkedAt` are NOT in the update. `linkedAt` is when the
        // provider was FIRST adopted here and re-adopting does not re-date it;
        // `id` is the row's identity, and `@@unique([environmentId, providerId])`
        // is not the primary key, so writing it would move an identity every
        // `EnvironmentProvider` reference still points at.
        update: { enabled: row.enabled, updatedAt: row.updatedAt },
        select: LINK_COLUMNS,
      });
      // The row as it NOW stands, not the draft. On a second adoption the
      // identity and the original `linkedAt` are the stored ones.
      return ok(readProviderLink(written));
    },

    async deleteProviderLink(
      scope: EnvironmentScope,
      provider: ProviderId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      const client = transactions.writer(transaction);
      // No savepoint, and that is a claim rather than an oversight: nothing
      // references `EnvironmentProvider`, so this DELETE has no foreign key to
      // restrict it and no trigger to refuse it. `deleteMany` rather than
      // `delete` so an absent adoption is `ok(false)` instead of a raised P2025.
      const removed = await client.environmentProvider.deleteMany({
        where: { providerId: provider, ...scopedWhere(scope) },
      });
      return ok(removed.count > 0);
    },
  };
}
