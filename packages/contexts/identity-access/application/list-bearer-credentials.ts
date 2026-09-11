// Use case: list the MCP bearer credentials of one environment, and count them.
//
// WIN-268 (M4.2). `GET /mcp/platform/tokens` and `GET /mcp/entity/:entityId/tokens`
// are both in `apps/agent/src/control-plane/operation-manifest.generated.json`
// with an `apps/agent` implementation and NOTHING in `apps/core-api`. A V1 route
// may only reach a contract method, so the routes could not be built until this
// existed — the same gap `mint-bearer-credential.ts` closed for the two mints.
//
// -----------------------------------------------------------------------------
// WHAT A LISTING OF CREDENTIALS MAY NOT RETURN
//
// Not the raw secret — that exists once, at mint, and no row holds it. And not
// the DIGEST either: `tokenHash` is the value every verification compares
// against, so a listing that returned it would hand a reader offline guessing
// material for every credential in an environment at once. The projection is
// `BearerCredentialSummary`, which HAS NO SUCH FIELD, so this is a compile error
// rather than a review note. `scripts/arch/secret-response-census.mjs` covers the
// transport that renders it; the type covers everything below the transport.
//
// -----------------------------------------------------------------------------
// THE TENANT COMES FROM AN AUTHORIZED SCOPE, AND THE ENTITY COMES WITH IT
//
// `ListBearerCredentialsInput` carries an `AuthorizationScope` — the value
// tenancy minted by re-deriving the whole chain from an environment id — and the
// store filters on the environment that scope names. There is no environment
// field a caller could substitute.
//
// FOR AN ENTITY TOKEN THE ENTITY IS PART OF THE ADDRESS, not a filter over the
// answer. `McpBearerToken` carries both `entityId` and `environmentId` and
// `tenancy/domain/entity.ts` says why neither derives from the other; a listing
// that took the environment and ignored the entity would show an operator holding
// one entity every OTHER entity's credentials in the same environment.
//
// THE PAGE AND THE TOTAL ARE READ UNDER ONE QUERY, for the reason
// `list-end-users.ts` gives: a total computed under different filtering from the
// page it describes is a pagination control that lies about how much is left.

import { ok, type Result } from "@platos/kernel";

import {
  planBearerCredentialPage,
  type AuthorizationScope,
  type BearerCredentialSummary,
  type MintableBearerKind,
} from "../domain/index.js";
import type { PortsOf } from "./dependencies.js";

export type ListBearerCredentialsPorts = PortsOf<"repository">;

export interface ListBearerCredentialsInput {
  readonly kind: MintableBearerKind;
  /** Already authorized. Never an environment id read off a request. */
  readonly scope: AuthorizationScope;
  /** The entity, for an entity token. Refused for a platform token. */
  readonly subjectId: string | null;
  /** Null means the fifty-row default. An over-large value is refused. */
  readonly limit: number | null;
  readonly offset: number | null;
}

export interface BearerCredentialPage {
  readonly credentials: readonly BearerCredentialSummary[];
  /** Rows matching the query, ignoring the page window. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** Whether another page exists — derived here, never asserted by the store. */
  readonly hasMore: boolean;
}

export async function listBearerCredentials(
  ports: ListBearerCredentialsPorts,
  input: ListBearerCredentialsInput,
): Promise<Result<BearerCredentialPage>> {
  const query = planBearerCredentialPage({
    kind: input.kind,
    scope: input.scope,
    subjectId: input.subjectId,
    limit: input.limit,
    offset: input.offset,
  });
  if (!query.ok) return query;

  const credentials = await ports.repository.bearerCredentials.list(query.value);
  const total = await ports.repository.bearerCredentials.count(query.value);
  return ok({
    credentials,
    total,
    limit: query.value.limit,
    offset: query.value.offset,
    hasMore: query.value.offset + query.value.limit < total,
  });
}
