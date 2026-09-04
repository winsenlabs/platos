// `EndUser` and `EndUserIdentity` — the SECOND principal tier, and the one this
// context is sole writer of but published no read of.
//
// ADR M0.3 §1 makes identity-access sole writer of `EndUser`. It had no read at
// all: the only place an end user was ever listed was
// `…env.$envParam.agent-accounts._index`, which reached past every contract into
// `database.endUser.findMany` / `.count`. That route is the source of the rule
// transcribed here.
//
// AN END USER IS NOT AN OPERATOR, and the two must never be confused. An
// operator is a human with a `User` row, a session, a second factor and a
// membership in the tenant tree. An end user is somebody a CUSTOMER's product
// knows about — a Slack account, an email address, a web session — who reaches
// the platform through a channel and holds no tenancy membership whatsoever.
// They share nothing but the `PrincipalId` widening in `principal.ts`, which is
// exactly why a listing keyed by the wrong tier would be a cross-tenant leak
// rather than a mistake in a filter.
//
// THE LISTING IS TENANT-SCOPED AND THE SCOPE IS NOT A PARAMETER A CALLER
// SUPPLIES. `EndUser.organizationId` is the only key the query is allowed to
// hang off, and the use case takes an already-authorized `TenantScope` to get
// it — the same discipline `authorizeEnvironmentOperator` gets from taking only
// the leaf. There is no organization id on the request type, so there is nothing
// to substitute.

import type { OrganizationId } from "@platos/kernel";
import { domainError, err, ok, type DomainError, type Result } from "@platos/kernel";

import type { EndUserId, EndUserIdentityId } from "./principal.js";

/** The largest page the oracle's collection config allows. */
export const MAX_END_USER_PAGE_SIZE = 100;
/** What the oracle asks for when a caller names no size. */
export const DEFAULT_END_USER_PAGE_SIZE = 25;
/** The oracle refuses a longer search term with a 400 rather than truncating. */
export const MAX_END_USER_SEARCH_LENGTH = 200;

export interface EndUserIdentityRecord {
  readonly identityId: EndUserIdentityId;
  readonly endUserId: EndUserId;
  /** Who vouched for the subject — a channel app, an IdP, the platform. */
  readonly issuer: string;
  readonly channel: string;
  /** The issuer's own identifier for the human. Never assumed unique globally. */
  readonly subject: string;
  readonly verifiedAt: Date | null;
  readonly disabledAt: Date | null;
}

export interface EndUserRecord {
  readonly endUserId: EndUserId;
  /** The tenant this row belongs to. The ONLY key a listing may hang off. */
  readonly organizationId: OrganizationId;
  readonly displayName: string | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
}

/** An end user plus the identities that reach them. */
export interface EndUserWithIdentities {
  readonly user: EndUserRecord;
  readonly identities: readonly EndUserIdentityRecord[];
}

export type EndUserStatusFilter = "active" | "disabled";

/**
 * What a caller may ask for. Note what is ABSENT: a tenant identifier.
 *
 * The organization is supplied by the use case from an authorized scope, so a
 * request object can be built by anybody and still cannot address another
 * tenant.
 */
export interface EndUserListRequest {
  readonly status?: string | null;
  readonly search?: string | null;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * A validated query. Minting one is the only way to get an `organizationId`
 * onto it, which is what stops a hand-built query reaching the store.
 */
export interface EndUserQuery {
  readonly organizationId: OrganizationId;
  readonly status: EndUserStatusFilter | null;
  readonly search: string | null;
  readonly limit: number;
  readonly offset: number;
}

export function invalidEndUserFilter(field: string, message: string): DomainError {
  return domainError("INVALID_END_USER_FILTER", "invalid_input", message, {
    fields: [{ field, code: "INVALID_END_USER_FILTER", message }],
  });
}

/**
 * Validate a listing request against an authorized organization.
 *
 * Every refusal below is the oracle's: `status` outside the two-value vocabulary
 * is a 400, a `pageSize` above the maximum is a 400 (NOT a clamp — a silently
 * clamped page is a caller that believes it has seen everything), a
 * non-integer or negative page is a 400, and a search term over 200 characters
 * is a 400.
 */
export function planEndUserPage(
  organizationId: OrganizationId,
  request: EndUserListRequest,
): Result<EndUserQuery> {
  const status = request.status ?? null;
  if (status !== null && status !== "active" && status !== "disabled") {
    return err(invalidEndUserFilter("status", "status must be active or disabled"));
  }

  const limit = request.limit ?? DEFAULT_END_USER_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return err(invalidEndUserFilter("limit", "limit must be a positive integer"));
  }
  if (limit > MAX_END_USER_PAGE_SIZE) {
    return err(
      invalidEndUserFilter("limit", `limit must be at most ${MAX_END_USER_PAGE_SIZE}`),
    );
  }

  const offset = request.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return err(invalidEndUserFilter("offset", "offset must be a non-negative integer"));
  }

  const search = (request.search ?? "").trim();
  if (search.length > MAX_END_USER_SEARCH_LENGTH) {
    return err(
      invalidEndUserFilter(
        "search",
        `search must be at most ${MAX_END_USER_SEARCH_LENGTH} characters`,
      ),
    );
  }

  return ok({
    organizationId,
    status,
    search: search.length === 0 ? null : search,
    limit,
    offset,
  });
}

/**
 * Whether one row belongs in the answer.
 *
 * The tenant clause is FIRST and is not part of the optional filtering: a row
 * from another organization is not a row that failed a filter, it is a row this
 * caller must never have been shown. Keeping it here as well as in the store's
 * WHERE is the same defence-in-depth the tenancy domain applies to memberships,
 * and it is what makes a leaking store a failing test rather than a breach.
 */
export function matchesEndUserQuery(row: EndUserWithIdentities, query: EndUserQuery): boolean {
  if (row.user.organizationId !== query.organizationId) return false;
  if (query.status === "active" && row.user.disabledAt !== null) return false;
  if (query.status === "disabled" && row.user.disabledAt === null) return false;
  if (query.search === null) return true;

  const needle = query.search.toLowerCase();
  const name = row.user.displayName ?? "";
  return (
    name.toLowerCase().includes(needle) ||
    row.identities.some((identity) => identity.subject.toLowerCase().includes(needle))
  );
}

/**
 * Newest first, id descending as the tiebreak — the oracle's
 * `orderBy: [{ createdAt: "desc" }, { id: "desc" }]`.
 *
 * The second key is what makes paging correct rather than merely ordered: rows
 * created in the same millisecond would otherwise come back in an unstable
 * order, and a caller walking pages would see one row twice and another never.
 */
export function compareEndUsers(left: EndUserRecord, right: EndUserRecord): number {
  const byCreation = right.createdAt.getTime() - left.createdAt.getTime();
  return byCreation !== 0 ? byCreation : right.endUserId.localeCompare(left.endUserId);
}
