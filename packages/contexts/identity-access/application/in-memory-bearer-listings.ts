// The listing half of the in-memory `BearerCredentialStore`.
//
// SPLIT OUT OF `in-memory-repository.ts` FOR THE BUDGET IT WAS ABOUT TO BREACH —
// ADR M0.3 §6, which `scripts/arch/max-file-lines.mjs` enforces — and the split
// falls on a real seam rather than at a line number: everything here is about the
// WHERE, the ORDER and the representability of a credential LISTING, none of
// which the other fourteen stores in that file have any part in.
//
// EVERY RULE BELOW IS ONE THE REAL SQL HAS TO REPRODUCE. That is what makes this
// a fake rather than a mock: a differential run against the PostgreSQL adapter
// compares the two, so a predicate implemented loosely here is a failing test
// rather than a double that flatters the use case.

import type {
  BearerCredentialKind,
  BearerCredentialQuery,
  BearerCredentialRecord,
  BearerCredentialRevocation,
  BearerCredentialRevocationResult,
  BearerCredentialSummary,
} from "../domain/index.js";

/**
 * The two maps these helpers read, and NOTHING ELSE OF THE STATE.
 *
 * A structural slice rather than `InMemoryState`, so this module cannot start
 * reaching into the other fourteen stores and cannot create an import cycle back
 * into the file it was split out of.
 */
export interface BearerListingState {
  readonly bearerCredentials: Map<string, BearerCredentialRecord>;
  readonly bearerCredentialListings: Map<string, InMemoryBearerListing>;
}

/**
 * The listing view of one credential, plus the two facts a listing FILTERS on.
 *
 * `environmentId` and `subjectId` are held beside the summary rather than in it,
 * because the published summary deliberately carries neither: the environment is
 * the scope the caller asked under and the entity is part of the address. Keeping
 * them here is what lets the double apply the same WHERE the SQL does.
 */
export interface InMemoryBearerListing {
  readonly summary: BearerCredentialSummary;
  readonly environmentId: string;
  readonly subjectId: string | null;
  /** So a revocation can update the `(kind, tokenHash)`-keyed record too. */
  readonly tokenHash: string;
}

/**
 * The oracles' ORDER, implemented rather than approximated.
 *
 * Both legacy listings order `[{ createdAt: "desc" }, { id: "desc" }]`, and the
 * id tiebreak is not decoration: two credentials minted in the same millisecond
 * would otherwise page in an arbitrary order and two consecutive pages could
 * overlap or skip a row.
 */
export function compareBearerListings(left: InMemoryBearerListing, right: InMemoryBearerListing): number {
  const byCreated = right.summary.createdAt.getTime() - left.summary.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  return right.summary.credentialId.localeCompare(left.summary.credentialId);
}

export function matchingBearerListings(
  state: BearerListingState,
  query: Pick<BearerCredentialQuery, "kind" | "environmentId" | "subjectId">,
): InMemoryBearerListing[] {
  return [...state.bearerCredentialListings.values()].filter((listing) =>
    matchesBearerQuery(listing, query),
  );
}

/**
 * Every credential the query's scope would match must be representable.
 *
 * See `list`'s note: only `mint` writes both maps, so a directly seeded record is
 * invisible to a listing and the honest answer is a throw rather than a page that
 * silently omits it. The check is on the RECORD side because that is the map a
 * test can seed without going through `mint`.
 */
export function requireListingsFor(state: BearerListingState, query: BearerCredentialQuery): void {
  const listed = new Set(
    [...state.bearerCredentialListings.values()].map((listing) => listing.summary.credentialId),
  );
  for (const record of state.bearerCredentials.values()) {
    if (record.kind !== query.kind) continue;
    if (record.scope.kind !== "ENVIRONMENT" || record.scope.tenant.level !== "environment") continue;
    if (record.scope.tenant.environmentId !== query.environmentId) continue;
    if (listed.has(record.credentialId)) continue;
    throw new Error(
      `bearer credential ${record.credentialId} was seeded without its listing columns; ` +
        "seed through mint, or add a state.bearerCredentialListings entry",
    );
  }
}

/** The WHERE, shared by `list`, `count` and `revoke`. */
export function matchesBearerQuery(
  listing: InMemoryBearerListing,
  query: Pick<BearerCredentialQuery, "kind" | "environmentId" | "subjectId">,
): boolean {
  if (listing.summary.kind !== query.kind) return false;
  if (listing.environmentId !== query.environmentId) return false;
  // THE ENTITY CLAUSE IS APPLIED ONLY WHEN THE QUERY NAMES ONE, and the planner
  // guarantees it names one exactly for `entity-bearer-token`. Applying it
  // unconditionally would make every platform listing empty; skipping it for an
  // entity listing would show one entity's operator another entity's credentials.
  if (query.subjectId !== null && listing.subjectId !== query.subjectId) return false;
  return true;
}

/**
 * The three store methods, over the two maps above.
 *
 * A FACTORY SPREAD INTO THE STORE rather than three loose functions, which is the
 * shape `packages/adapters/postgres-tenancy/src/identity-bearer.ts` uses for the
 * canonical store's identical split. Keeping the fake and the real implementation
 * the same shape is what lets a reader hold them side by side, and it is why the
 * differential run between them compares like with like.
 *
 * `bearerKey` ARRIVES rather than being redefined. It is the `(kind, tokenHash)`
 * key `findByTokenHash` and `save` use, and a second spelling of it here would be a
 * second answer to "which row is this" — the revocation below has to reach the
 * authentication-side record through exactly the key those two methods wrote it
 * under, or a revoked credential keeps authenticating.
 */
export function createInMemoryBearerLifecycle(
  state: BearerListingState,
  bearerKey: (kind: BearerCredentialKind, tokenHash: string) => string,
) {
  return {
  /**
   * WIN-268 (M4.2) — the listing, and it REFUSES rather than under-reporting.
   *
   * A credential seeded straight into `state.bearerCredentials` has no entry
   * in `state.bearerCredentialListings`, because only `mint` writes both. A
   * double that quietly skipped such a row would answer a short page and a
   * short total, and a use-case test asserting "two credentials, one page"
   * would pass against a store that had lost one. So the mismatch is a loud
   * throw naming the credential, which is the same reason `save` refuses a
   * digest no row carries.
   */
  async list(query: BearerCredentialQuery): Promise<readonly BearerCredentialSummary[]> {
    requireListingsFor(state, query);
    return matchingBearerListings(state, query)
      .sort(compareBearerListings)
      .slice(query.offset, query.offset + query.limit)
      .map((listing: InMemoryBearerListing) => listing.summary);
  },

  /** The same predicate WITHOUT the window: a total that counted only the
   * page would make `hasMore` permanently false. */
  async count(query: BearerCredentialQuery): Promise<number> {
    requireListingsFor(state, query);
    return matchingBearerListings(state, query).length;
  },

  /**
   * WIN-268 (M4.2) — the CONDITIONAL revocation, implemented faithfully.
   *
   * `revokedAt: null` IS THE PRECONDITION, exactly as the SQL's `WHERE ...
   * revokedAt IS NULL` is. A double that overwrote unconditionally would let a
   * use case that dropped `newlyRevoked` keep passing, and would report the
   * second revoker's instant as the moment the credential was ended — which is
   * the fact an operator reads to find out when a leak was closed.
   *
   * EXPIRY IS NOT A PRECONDITION. Both oracles revoke a lapsed credential
   * without checking, and the use case's own banner says why that is right.
   */
  async revoke(
    revocation: BearerCredentialRevocation,
  ): Promise<BearerCredentialRevocationResult | null> {
    const listing = state.bearerCredentialListings.get(revocation.credentialId);
    if (listing === undefined || !matchesBearerQuery(listing, revocation)) return null;
    if (listing.summary.revokedAt !== null) {
      return { credential: listing.summary, newlyRevoked: false };
    }
    const summary: BearerCredentialSummary = {
      ...listing.summary,
      revokedAt: revocation.revokedAt,
      // `McpBearerToken` HAS NO `revokedBy` COLUMN. The double drops the value
      // for that kind because the table would, and reporting it would make the
      // fake answer something the canonical store cannot.
      revokedBy:
        revocation.kind === "mcp-token" ? revocation.revokedByUserId : null,
    };
    state.bearerCredentialListings.set(revocation.credentialId, { ...listing, summary });
    const key = bearerKey(revocation.kind, listing.tokenHash);
    const record = state.bearerCredentials.get(key);
    if (record !== undefined) {
      // THE AUTHENTICATION-SIDE ROW MOVES WITH IT. They are one row in the
      // real store, and a double that ended only the listing would let a
      // revoked credential keep authenticating — the exact failure the route
      // exists to prevent.
      state.bearerCredentials.set(key, { ...record, revokedAt: revocation.revokedAt });
    }
    return { credential: summary, newlyRevoked: true };
  },
  };
}
