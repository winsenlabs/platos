// Use cases: LIST the bearer credentials of one environment, and REVOKE one.
//
// WHY THEY EXIST, MEASURED RATHER THAN ASSERTED. `scripts/arch/mcp-store-ownership.mjs`
// is a register of every ORM call on the MCP surface with a required disposition
// per file, and two of those dispositions said this in the tree before this
// tranche: "`list` and `revoke` are not published by `identity-access` at all,
// which is what keeps `GET /mcp/platform/tokens` and
// `POST /mcp/platform/tokens/:id/revoke` in this deployable", and, for the entity
// service, "there is no `listBearerCredentials` and no `revokeBearerCredential`,
// so `GET /mcp/entity/:entityId/tokens` and
// `DELETE /mcp/entity/:entityId/tokens/:tokenId` cannot be served from a
// contract." Four operations in the generated manifest, no V1 handler for any of
// them, and one missing pair of contract methods behind all four.
//
// BOTH USE CASES ARE IN ONE FILE ON PURPOSE. They share the plan (`AuthorizationScope`
// in, environment out), the kind enumeration and the summary projection, and
// splitting them would put the listing's tenancy clause in one file and the
// revocation's — the SAME clause, and the one that matters more — in another.
//
// -----------------------------------------------------------------------------
// WHAT NEITHER OF THEM DOES
//
// NEITHER DECIDES WHETHER THE CALLER MAY REACH THE ENVIRONMENT. That is
// `tenancy`'s four-gate decision, made before either is called, and the scope
// that arrives here is the branded value it returned. This layer enforces the
// narrower rule it can enforce alone: the answer is bounded by that environment
// and by nothing the request said.
//
// NEITHER WRITES AN AUDIT ROW. `mcp-bearer-token.revoke` in `apps/agent` appends
// an `AdminAudit` beside its update, and `AdminAudit` is `observability`'s row by
// ADR M0.3 §1 — a context this deployable does not compose. Writing it from here
// would make identity-access sole writer of a table it does not own. The register
// records those three `AdminAudit` sites as `blockedOnContext` against
// `observability` for exactly this reason, and they stay that way.

import {
  planBearerCredentialPage,
  planBearerRevocation,
  type BearerCredentialListRequest,
  type BearerCredentialSummary,
  type BearerRevocationOutcome,
  type ListableBearerKind,
} from "../domain/index.js";
import type { AuthorizationScope } from "../domain/index.js";
import type { PortsOf } from "./dependencies.js";
import { ok, type Result } from "@platos/kernel";

/**
 * The domain types these use cases' signatures publish.
 *
 * Re-exported rather than left un-nameable, the same way `list-end-users.ts` does
 * it: `BearerCredentialPage` carries `BearerCredentialSummary`, so a composition
 * root can already hold one of these values and, without this, could not write
 * its type down.
 */
export type {
  BearerCredentialListRequest,
  BearerCredentialSummary,
  BearerRevocationOutcome,
  ListableBearerKind,
} from "../domain/index.js";

export type ReadBearerCredentialsPorts = PortsOf<"repository">;
export type RevokeBearerCredentialPorts = PortsOf<"repository" | "clock">;

export interface ListBearerCredentialsInput extends BearerCredentialListRequest {
  /** Already authorized by `tenancy`. Never a raw id from a request. */
  readonly scope: AuthorizationScope;
}

export interface BearerCredentialPage {
  readonly credentials: readonly BearerCredentialSummary[];
  /** Rows matching the query, ignoring the page window. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** Whether another page exists — DERIVED, never asserted by the store. */
  readonly hasMore: boolean;
}

/**
 * List one environment's credentials of one kind.
 *
 * THE PAGE AND THE TOTAL COME FROM THE SAME QUERY OBJECT, which is the property
 * `BearerCredentialStore`'s own note names: a count taken under different
 * filtering describes a different collection from the one the caller is holding.
 */
export async function listBearerCredentials(
  ports: ReadBearerCredentialsPorts,
  input: ListBearerCredentialsInput,
): Promise<Result<BearerCredentialPage>> {
  const query = planBearerCredentialPage(input.scope, input);
  if (!query.ok) return query;

  const credentials = await ports.repository.bearerCredentials.list(query.value);
  const total = await ports.repository.bearerCredentials.count(query.value);
  return ok({
    credentials,
    total,
    limit: query.value.limit,
    offset: query.value.offset,
    hasMore: query.value.offset + credentials.length < total,
  });
}

export interface RevokeBearerCredentialInput {
  readonly kind: ListableBearerKind;
  readonly credentialId: string;
  /** The entity, for an `entity-bearer-token`. Refused for an `mcp-token`. */
  readonly subjectId?: string | null;
  /** Already authorized by `tenancy`. Never a raw id from a request. */
  readonly scope: AuthorizationScope;
  /** The operator who asked. Recorded where the table has a column for it. */
  readonly revokedByUserId: string;
}

/**
 * Revoke one credential, and report which of three things happened.
 *
 * THE INSTANT COMES FROM THE CLOCK PORT AND IS PASSED DOWN, so the whole
 * operation is replayable at a fixed time in a test. The store applies it inside
 * its conditional update rather than reading a clock of its own, which is what
 * makes the two concurrent-revocation outcomes distinguishable at all: both
 * writers carry an instant, exactly one row transitions, and the loser reads back
 * the WINNER's instant instead of stamping its own.
 */
export async function revokeBearerCredential(
  ports: RevokeBearerCredentialPorts,
  input: RevokeBearerCredentialInput,
): Promise<Result<BearerRevocationOutcome>> {
  const plan = planBearerRevocation(input.scope, {
    kind: input.kind,
    credentialId: input.credentialId,
    subjectId: input.subjectId ?? null,
    revokedByUserId: input.revokedByUserId,
    now: ports.clock.now(),
  });
  if (!plan.ok) return plan;

  // A `Result` WRAPPING AN OUTCOME, and neither layer collapses into the other.
  // The `Result` reports whether the REQUEST could be answered — a malformed
  // query, a scope that is not an environment — and the outcome reports what was
  // TRUE of the credential. An absent credential is not a failed request: the
  // caller asked a well-formed question and the answer is "there is no such
  // credential here". A transport turns that into a 404; a use case that returned
  // `err` for it would make an unauthorized cross-environment probe and a typo
  // indistinguishable from a broken request.
  return ok(await ports.repository.bearerCredentials.revoke(plan.value));
}
