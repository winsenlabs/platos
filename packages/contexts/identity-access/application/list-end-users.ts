// Use case: list the end users of one tenant, and count them.
//
// identity-access is sole writer of `EndUser` (ADR M0.3 §1, context 1) and
// published no read of it, so the only listing in the product reached past every
// contract into `database.endUser.findMany` and `database.endUser.count`.
//
// THE TENANT COMES FROM AN AUTHORIZED SCOPE, NOT FROM THE REQUEST. The input
// carries a `TenantScope` — the value tenancy minted by re-deriving the whole
// chain from an environment id — and the organization is widened out of it here.
// `EndUserListRequest` has no tenant field at all, so a caller has nothing to
// substitute, and a transport cannot accidentally forward an organization id
// from a query string.
//
// THE PAGE AND THE TOTAL ARE READ UNDER ONE QUERY. The oracle issues the two
// reads in a `Promise.all` over the same `where`, and the same query object goes
// to both stores here. A total computed under different filtering from the page
// it describes is a pagination control that lies to the caller about how much
// is left.

import { toOrganizationScope, ok, type Result, type TenantScope } from "@platos/kernel";

import {
  planEndUserPage,
  type EndUserListRequest,
  type EndUserWithIdentities,
} from "../domain/index.js";
import type { PortsOf } from "./dependencies.js";

/**
 * The domain types this use case's own signature publishes.
 *
 * Re-exported here rather than left un-nameable: `EndUserPage` carries
 * `EndUserWithIdentities`, so the composition root can already HOLD these values
 * and, without this, could not write the type of one down.
 */
export type {
  EndUserId,
  EndUserIdentityId,
  EndUserIdentityRecord,
  EndUserRecord,
  EndUserWithIdentities,
} from "../domain/index.js";

export type ListEndUsersPorts = PortsOf<"repository">;

export interface ListEndUsersInput extends EndUserListRequest {
  /** Already authorized. Never a raw organization id from a request. */
  readonly scope: TenantScope;
}

export interface EndUserPage {
  readonly users: readonly EndUserWithIdentities[];
  /** Rows matching the filters, ignoring the page window. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** Whether another page exists — derived, never asserted by the store. */
  readonly hasMore: boolean;
}

export async function listEndUsers(
  ports: ListEndUsersPorts,
  input: ListEndUsersInput,
): Promise<Result<EndUserPage>> {
  const organization = toOrganizationScope(input.scope);
  const query = planEndUserPage(organization.organizationId, {
    status: input.status ?? null,
    search: input.search ?? null,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
  });
  if (!query.ok) return query;

  const users = await ports.repository.endUsers.list(query.value);
  const total = await ports.repository.endUsers.count(query.value);
  return ok({
    users,
    total,
    limit: query.value.limit,
    offset: query.value.offset,
    hasMore: query.value.offset + query.value.limit < total,
  });
}
