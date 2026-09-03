// Use cases: read provider keys.
//
// METADATA ONLY, AND NOT BY ACCIDENT. Listing keys never decrypts, never probes
// and never asks the vault whether the material behind a key still works. A
// ProviderKey can only be created against a usable credential, so the row's
// existence is already the readiness statement a listing needs; live readiness
// is what the explicitly-gated health surface is for. The source records this as
// a deliberate property of the listing route and it is preserved.
//
// The grant required is `metadata`, the weaker of tenancy's two levels.

import { err, ok, type Result } from "@platos/kernel";

import {
  asProvidersIdentifier,
  byListingOrder,
  providerKeyNotFound,
  type ProviderId,
  type ProviderKey,
  type ProviderKeyId,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";
import type { ProviderKeyPage } from "./ports/index.js";

export interface ReadProviderKeysQuery {
  readonly authorization: unknown;
}

export interface PageProviderKeysQuery extends ReadProviderKeysQuery {
  readonly limit: number;
  readonly offset: number;
  readonly provider?: string | null;
  readonly search?: string | null;
}

export interface DescribeProviderKeyQuery extends ReadProviderKeysQuery {
  readonly providerKeyId: ProviderKeyId;
}

/** Widest page a caller may ask for, whatever it requests. */
export const MAX_PROVIDER_KEY_PAGE = 200;

export async function listProviderKeys(
  dependencies: ProvidersDependencies,
  query: ReadProviderKeysQuery,
): Promise<Result<readonly ProviderKey[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const listed = await dependencies.repository.listProviderKeys(granted.value.scope);
  if (!listed.ok) return err(listed.error);
  // Sorted here as well as in the store. The store's order is the one that makes
  // paging correct; repeating it here makes an unpaged listing independent of
  // whether a particular adapter honoured it.
  return ok([...listed.value].sort(byListingOrder));
}

export async function pageProviderKeys(
  dependencies: ProvidersDependencies,
  query: PageProviderKeysQuery,
): Promise<Result<ProviderKeyPage>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);

  const search = query.search?.trim();
  return dependencies.repository.pageProviderKeys(granted.value.scope, {
    limit: Math.min(Math.max(Math.trunc(query.limit), 1), MAX_PROVIDER_KEY_PAGE),
    offset: Math.max(Math.trunc(query.offset), 0),
    provider: narrowProvider(query.provider),
    // An empty search is NOT a search. Passing `""` down would make every
    // adapter decide privately whether that means "everything" or "nothing".
    search: search === undefined || search === "" ? null : search,
  });
}

export async function describeProviderKey(
  dependencies: ProvidersDependencies,
  query: DescribeProviderKeyQuery,
): Promise<Result<ProviderKey>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const found = await dependencies.repository.findProviderKey(granted.value.scope, query.providerKeyId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(providerKeyNotFound(query.providerKeyId));
  return ok(found.value);
}

/** A blank provider filter is no filter, the same rule the search field follows. */
function narrowProvider(value: string | null | undefined): ProviderId | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : asProvidersIdentifier<ProviderId>(trimmed);
}
