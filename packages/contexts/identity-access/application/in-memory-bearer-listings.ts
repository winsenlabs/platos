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
  BearerCredentialQuery,
  BearerCredentialRecord,
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
