// The `ProviderKey` half of `ProvidersRepository` — environment-scoped, and the
// half PostgreSQL guards hardest.
//
// FIVE DATABASE RULES STAND OVER THIS ONE TABLE and NOT ONE of them is in
// `schema.prisma`, so not one is in the generated client's types and not one is
// in `InMemoryProvidersRepository`:
//
//   `ProviderKey_environmentId_provider_label_key`     the label is unique per
//     environment and provider. The double models this one.
//   `ProviderKey_one_default_per_environment_provider` a PARTIAL unique index,
//     `WHERE "isDefault" = TRUE`. The double models it as a scan.
//   `ProviderKey_credential_provider_integrity`        a BEFORE INSERT OR UPDATE
//     trigger demanding a `Credential` in the SAME environment whose `provider`
//     equals this row's and whose `name` equals `environmentKeyName`. The double
//     stores any `credentialId` at all.
//   `ProviderKey_owner_immutable`                      a BEFORE UPDATE trigger
//     freezing `environmentId`.
//   `ProviderKey_executable_reference`                 a BEFORE DELETE trigger
//     refusing to delete a key an EXECUTABLE `AgentVersion` still names, in
//     either of the two places a version can name one.
//
// THE ORDER IS APPLIED IN JAVASCRIPT AND THAT IS A FINDING, NOT A SHORTCUT.
// `byListingOrder` compares `provider` with `<` on JavaScript strings — UTF-16
// code units — and `ORDER BY "provider"` applies the database's COLLATION, which
// on a default `en_US.utf8` cluster is a locale order that ignores case and
// punctuation at the primary level. The two disagree on the FIRST key of the
// comparator: JavaScript puts `"Zebra"` before `"apple"`, a locale-collated
// PostgreSQL puts `"apple"` first. The port says an implementation MUST apply
// `byListingOrder` "including its final id tie-break", so the order is applied
// where that comparator lives, over the decoded rows, and the page is cut after
// it. `cost-budgets.ts` cuts its page the same way for a different reason; here
// the reason is the collation.
//
// THAT COSTS ONE STATEMENT AND NOT MORE. The scope predicate and the provider
// filter are both in the SELECT, so the read is bounded by the keys one
// environment holds for one provider, and `total` comes from the same read
// rather than from a second `count` — a page and a total that disagree about
// which rows exist is a listing that flickers.

import type {
  EnvironmentScope,
  ProviderId,
  ProviderKey,
  ProviderKeyId,
  ProviderKeyPage,
  ProviderKeyQuery,
  Result,
  TransactionScope,
} from "@platos/context-providers/application/ports/index.js";
import {
  byListingOrder,
  credentialUnavailable,
  err,
  ok,
  providerKeyAlreadyExists,
  providerKeyPinnedByAgents,
  repositoryUnavailable,
  type DomainError,
} from "@platos/context-providers/application/ports/index.js";

import {
  namesConstraint,
  providersRefusable,
  raisedMessageOf,
  requirePageWindow,
  sqlstateOf,
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  UNIQUE_VIOLATION,
} from "./providers-guards.js";
import { readProviderKey, writeProviderKey, type ProviderKeyRow } from "./providers-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** The columns every `ProviderKey` read selects. One place, so no read is wider. */
const KEY_COLUMNS = {
  id: true,
  environmentId: true,
  credentialId: true,
  provider: true,
  label: true,
  environmentKeyName: true,
  isDefault: true,
  createdBy: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The ancestry predicate every scoped read carries.
 *
 * NOT `environmentId` ALONE, for the reason `cost-rows.ts` states one store
 * over: `EnvironmentScope` names an organization, a project and an environment,
 * and a caller holding a grant for one tenant can hand an environment id
 * belonging to another. Spelled as a relation filter it costs no extra
 * statement — the driver folds it into the same SELECT — and it makes this store
 * STRICTER than the double, which compares `environmentId` and stops.
 */
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

/**
 * Which of `ProviderKey`'s rules refused, as the domain error the port answers.
 *
 * THE THREE UNIQUE INDEXES ARE TOLD APART BY THEIR COLUMN LISTS. `meta.target`
 * carries the columns for a violation the client recognises, and the partial
 * one-default index is reported by its NAME because it is a partial index the
 * client has no model of. Collapsing them would tell an operator who promoted a
 * second default that their LABEL was taken.
 *
 * `providerKeyAlreadyExists(provider, "default")` is spelled exactly as
 * `InMemoryProvidersRepository` spells it. The shared conformance scenario
 * compares the two stores' observations verbatim, so a store that improved the
 * wording would be reporting a different outcome for the same event.
 */
function keyRefusal(key: ProviderKey, error: unknown): DomainError | null {
  const sqlstate = sqlstateOf(error);
  if (sqlstate === UNIQUE_VIOLATION) {
    if (namesConstraint(error, "ProviderKey_one_default_per_environment_provider")) {
      return providerKeyAlreadyExists(key.provider, "default");
    }
    if (namesConstraint(error, "environmentId,provider,label")) {
      return providerKeyAlreadyExists(key.provider, key.label);
    }
    // The primary key, which is a caller minting an identifier already in use.
    return repositoryUnavailable("provider key id already exists");
  }
  if (
    sqlstate === CHECK_VIOLATION &&
    raisedMessageOf(error).includes("ProviderKey credential/provider mismatch")
  ) {
    // The trigger's own subject, in the context's own vocabulary: from the
    // operator's position the credential they named does not exist HERE, for
    // THIS provider, which is exactly what `credentialUnavailable` says.
    return credentialUnavailable(key.credentialName, key.provider);
  }
  if (sqlstate === CHECK_VIOLATION && raisedMessageOf(error).includes("is immutable")) {
    return repositoryUnavailable("provider key environment is immutable");
  }
  if (sqlstate === FOREIGN_KEY_VIOLATION) {
    // `ProviderKey_credentialId_environmentId_fkey` is `ON DELETE RESTRICT`, so
    // this is a credential that is not in this environment at all.
    return credentialUnavailable(key.credentialName, key.provider);
  }
  return null;
}

export interface ProviderKeyStore {
  listProviderKeys(scope: EnvironmentScope): Promise<Result<readonly ProviderKey[]>>;
  pageProviderKeys(scope: EnvironmentScope, query: ProviderKeyQuery): Promise<Result<ProviderKeyPage>>;
  findProviderKey(scope: EnvironmentScope, providerKeyId: ProviderKeyId): Promise<Result<ProviderKey | null>>;
  listProviderKeysFor(scope: EnvironmentScope, provider: ProviderId): Promise<Result<readonly ProviderKey[]>>;
  insertProviderKey(key: ProviderKey, transaction: TransactionScope): Promise<Result<ProviderKey>>;
  updateProviderKey(key: ProviderKey, transaction: TransactionScope): Promise<Result<ProviderKey>>;
  deleteProviderKey(
    scope: EnvironmentScope,
    providerKeyId: ProviderKeyId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;
  countAgentVersionsPinning(
    scope: EnvironmentScope,
    providerKeyId: ProviderKeyId,
  ): Promise<Result<number>>;
  touchProviderKey(providerKeyId: ProviderKeyId, usedAt: Date): Promise<Result<void>>;
}

export function createProviderKeyStore(transactions: TenancyTransactions): ProviderKeyStore {
  /** Every key in a scope, optionally narrowed to a provider, in domain order. */
  async function keysIn(
    scope: EnvironmentScope,
    provider: ProviderId | null,
  ): Promise<ProviderKey[]> {
    const rows = await transactions.reader().providerKey.findMany({
      where: { ...scopedWhere(scope), ...(provider === null ? {} : { provider }) },
      select: KEY_COLUMNS,
    });
    return rows.map((row: ProviderKeyRow) => readProviderKey(row)).sort(byListingOrder);
  }

  /**
   * How many EXECUTABLE agent versions name this key.
   *
   * Raw SQL because no delegate query can express it: a version pins a key
   * inside `memoryConfig` at `{__runtime,providerKeyId}` and inside every entry
   * of the `modelRoutes` ARRAY, and walking a JSON array is
   * `jsonb_array_elements`. The predicate is transcribed from
   * `reject_executable_provider_key_delete` in the initial migration, including
   * the `split_part(model, ':', 1) = provider` clause both halves carry — a
   * route that names this key but a DIFFERENT provider's model is not a use of
   * this key, and counting it would refuse a delete the database would allow.
   *
   * It is a COUNT and not a boolean because `providerKeyPinnedByAgents` reports
   * it: an operator told "three agent versions still use this" can go and fix
   * them.
   */
  async function pinnedBy(scope: EnvironmentScope, providerKeyId: string): Promise<number> {
    const rows = await transactions.reader().$queryRaw<readonly { readonly pinned: number }[]>`
      SELECT COUNT(*)::int AS "pinned"
        FROM "Environment" environment
        JOIN "Project" project ON project."id" = environment."projectId"
        JOIN "ProviderKey" key ON key."environmentId" = environment."id"
        JOIN "AgentBinding" binding ON binding."environmentId" = environment."id"
        JOIN "Agent" agent ON agent."id" = binding."agentId" AND agent."projectId" = project."id"
        JOIN "AgentVersion" version ON version."agentId" = agent."id"
       WHERE key."id" = ${providerKeyId}::uuid
         AND environment."id" = ${scope.environmentId}::uuid
         AND environment."projectId" = ${scope.projectId}::uuid
         AND project."organizationId" = ${scope.organizationId}::uuid
         AND (
           (
             version."memoryConfig" #>> '{__runtime,providerKeyId}' = key."id"::text
             AND split_part(version."model", ':', 1) = key."provider"
           )
           OR EXISTS (
             SELECT 1
               FROM jsonb_array_elements(version."modelRoutes") route
              WHERE split_part(COALESCE(route ->> 'model', ''), ':', 1) = key."provider"
                AND (
                  route ->> 'providerCredentialId' = key."id"::text
                  OR route ->> 'providerKeyId' = key."id"::text
                )
           )
         )
    `;
    return rows[0]?.pinned ?? 0;
  }

  return {
    async listProviderKeys(scope: EnvironmentScope): Promise<Result<readonly ProviderKey[]>> {
      return ok(await keysIn(scope, null));
    },

    async pageProviderKeys(
      scope: EnvironmentScope,
      query: ProviderKeyQuery,
    ): Promise<Result<ProviderKeyPage>> {
      requirePageWindow(query.limit, query.offset);
      const all = await keysIn(scope, query.provider);
      // The search runs over the DECODED rows rather than as `contains` with
      // `mode: "insensitive"`, and that is deliberate. Prisma builds that filter
      // as `ILIKE '%' || $1 || '%'` and does NOT escape the needle, so a search
      // for `100%` would match every row and a search for `a_b` would match
      // `axb` — while the double, and the surface, do a plain lowercased
      // substring test. Two different answers for one search term is the
      // divergence the conformance run exists to catch.
      const needle = query.search === null ? null : query.search.toLowerCase();
      const matched =
        needle === null
          ? all
          : all.filter((key) =>
              [key.provider, key.label, key.credentialName].some((field) =>
                field.toLowerCase().includes(needle),
              ),
            );
      return ok({
        items: matched.slice(query.offset, query.offset + query.limit),
        total: matched.length,
      });
    },

    async findProviderKey(
      scope: EnvironmentScope,
      providerKeyId: ProviderKeyId,
    ): Promise<Result<ProviderKey | null>> {
      // `findFirst` with the scope in the WHERE, never `findUnique` by id. A key
      // that exists in another environment must be ABSENT here, and a unique
      // lookup followed by a JavaScript comparison would have read the row
      // first — which is the read a cross-tenant probe measures.
      const row = await transactions.reader().providerKey.findFirst({
        where: { id: providerKeyId, ...scopedWhere(scope) },
        select: KEY_COLUMNS,
      });
      return ok(row === null ? null : readProviderKey(row));
    },

    async listProviderKeysFor(
      scope: EnvironmentScope,
      provider: ProviderId,
    ): Promise<Result<readonly ProviderKey[]>> {
      return ok(await keysIn(scope, provider));
    },

    async insertProviderKey(
      key: ProviderKey,
      transaction: TransactionScope,
    ): Promise<Result<ProviderKey>> {
      const client = transactions.writer(transaction);
      // INSIDE A SAVEPOINT, not `createMany({ skipDuplicates: true })`. Two of
      // the five rules over this table are TRIGGERS that raise BEFORE the
      // conflict resolution `ON CONFLICT DO NOTHING` performs, so the form that
      // works for `cost-monitoring`'s append-only rows cannot work here: a
      // credential mismatch would abort the transaction whatever the conflict
      // clause said. And the demotion this insert follows is IN that
      // transaction.
      const written = await providersRefusable(
        client,
        () => client.providerKey.create({ data: writeProviderKey(key), select: KEY_COLUMNS }),
        (error) => keyRefusal(key, error),
      );
      if (!written.ok) return err(written.refusal);
      return ok(readProviderKey(written.value));
    },

    async updateProviderKey(
      key: ProviderKey,
      transaction: TransactionScope,
    ): Promise<Result<ProviderKey>> {
      const client = transactions.writer(transaction);
      const row = writeProviderKey(key);
      // KEYED ON BOTH id AND environmentId, and `environmentId` is NOT in the
      // data. `ProviderKey_owner_immutable` would refuse a move anyway; writing
      // the key by id alone would still have let a caller holding a key from
      // another tenant edit its LABEL, which no trigger refuses. Writing zero
      // rows and answering "no such provider key" is the same answer a caller
      // gets for an id that does not exist, which is the answer a foreign id
      // deserves.
      const { id, environmentId, createdAt, createdBy, ...mutable } = row;
      const written = await providersRefusable(
        client,
        () => client.providerKey.updateMany({ where: { id, environmentId }, data: mutable }),
        (error) => keyRefusal(key, error),
      );
      if (!written.ok) return err(written.refusal);
      if (written.value.count === 0) return err(repositoryUnavailable("no such provider key"));
      return ok(key);
    },

    async deleteProviderKey(
      scope: EnvironmentScope,
      providerKeyId: ProviderKeyId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      const client = transactions.writer(transaction);
      const removed = await providersRefusable(
        client,
        () =>
          client.providerKey.deleteMany({
            where: { id: providerKeyId, ...scopedWhere(scope) },
          }),
        // The classifier answers a REASON, not an error, because the error this
        // refusal deserves carries a COUNT the trigger does not report — it says
        // THAT an executable version names the key and never HOW MANY. Minting
        // the error here would have meant inventing that number, which is the
        // fabrication tranche 3 refused on `OperatorSessionRevoker.revoke`.
        (error) =>
          sqlstateOf(error) === FOREIGN_KEY_VIOLATION &&
          raisedMessageOf(error).includes("referenced by an executable AgentVersion")
            ? "pinned_by_executable_version"
            : null,
      );
      if (!removed.ok) {
        // The savepoint has already rolled the DELETE back, so the versions the
        // trigger saw are still there and the count IS obtainable — one extra
        // statement, only on the path that was already exceptional.
        const pinned = await pinnedBy(scope, providerKeyId);
        return err(providerKeyPinnedByAgents(providerKeyId, pinned));
      }
      return ok(removed.value.count > 0);
    },

    async countAgentVersionsPinning(
      scope: EnvironmentScope,
      providerKeyId: ProviderKeyId,
    ): Promise<Result<number>> {
      return ok(await pinnedBy(scope, providerKeyId));
    },

    async touchProviderKey(providerKeyId: ProviderKeyId, usedAt: Date): Promise<Result<void>> {
      // `pool()`, NOT `writer(...)` and NOT `reader()`. The port says this write
      // must not enlist in the caller's unit of work — "enlisting it in the
      // caller's unit of work would make a failed write of this timestamp roll
      // back the turn that succeeded" — and `reader()` resolves to the ambient
      // transaction's own client whenever one is open, which is precisely the
      // enlistment the port forbids.
      //
      // NO SCOPE, because the port's signature has none: it is called from the
      // turn path with a key the caller has already resolved through a scoped
      // read. `updateMany` rather than `update` so a key deleted between the
      // resolve and the touch is a no-op rather than a raised P2025.
      await transactions.pool().providerKey.updateMany({
        where: { id: providerKeyId },
        data: { lastUsedAt: usedAt },
      });
      return ok(undefined);
    },
  };
}
