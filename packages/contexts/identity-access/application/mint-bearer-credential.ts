// Mint one of the two MCP bearer credentials, and hand the caller the ONLY copy
// of the secret it will ever see.
//
// WHY THIS USE CASE EXISTS, PRECISELY. `apps/core-api/src/http/idempotency-policy.ts`
// classes exactly eight operations `required`: no `Idempotency-Key`, no
// execution. Two of the eight are `POST /mcp/platform/tokens` and
// `POST /mcp/entity/:entityId/tokens`. Both had handlers in `apps/agent` and
// NEITHER had one in `apps/core-api`, which is the process the idempotency gate
// runs in — so a caller that sent a key was reserved, admitted, and then handed
// the framework's own 404, while the reservation it now held recorded that 404
// for every retry of that key for a day. A route that a contract binds and no
// handler answers is worse than an absent route.
//
// -----------------------------------------------------------------------------
// THE SECRET EXISTS IN THIS PROCESS EXACTLY ONCE
//
// `minter.mint(kind)` produces the raw token; `hasher.hash(...)` produces the
// verifier; the STORE receives only the verifier and the caller receives only
// the raw value. Nothing writes the raw token to a log, a span or a returned
// record, and the returned view carries it in a field a reader cannot mistake
// for metadata. That is what "one-time secret" means, and it is why M0.4 §2
// makes `Idempotency-Key` REQUIRED on this operation rather than accepted: a
// mint that ran twice on a retry leaves a live credential nobody knows about,
// and a mint whose response was lost leaves the caller unable to recover the one
// it did create.
//
// -----------------------------------------------------------------------------
// THE SCOPE THE STORE RE-DERIVES IS THE AUTHORITY, NOT THE ONE THAT ARRIVED
//
// The caller passes the scope it was authorized for, and the store answers with
// the scope it read back off the environment's own ancestry. They differ exactly
// when a caller named an environment that does not belong to the project or
// organization it claimed — the forged triple — and this use case returns the
// STORE's answer, so a view can never report a tenancy the row does not have.
//
// The cross-tenant check itself is `tenancy`'s and is made before this is
// called. What is here is the narrower rule identity-access can enforce alone:
// the credential's scope is whatever the row says, and nothing is echoed.

import {
  credentialMintRefused,
  planBearerCredential,
  type BearerCredentialRecord,
  type McpPermissionTier,
  type MintableBearerKind,
  type TokenHash,
} from "../domain/index.js";
import type { PortsOf } from "./dependencies.js";
import { err, ok, type PrincipalId, type Result, type TenantScope } from "@platos/kernel";
import { tenantAuthorizationScope } from "../domain/authorization-scope.js";

export type MintBearerCredentialPorts = PortsOf<
  "repository" | "clock" | "ids" | "minter" | "hasher" | "logger"
>;

export interface MintBearerCredentialCommand {
  readonly kind: MintableBearerKind;
  /**
   * The scope the caller was AUTHORIZED for, not one it assembled from a URL.
   * It must be an environment scope; a bearer credential bounded by an
   * organization would be a credential no environment check could narrow.
   */
  readonly scope: TenantScope;
  /** `McpToken.name` / `McpBearerToken.label`. Shown to a human, never parsed. */
  readonly label: string;
  /** `McpToken.permissions` / `McpBearerToken.scopes`. */
  readonly permissions: readonly string[];
  /** The operator who minted it. Preserved for audit; never the principal for an entity token. */
  readonly createdByUserId: string;
  /**
   * Whom the credential acts as. See `BearerCredentialMint.principalId`.
   *
   * NULL IS ONLY MEANINGFUL FOR AN `entity-bearer-token`, and it means "this
   * credential acts as nobody but itself". The oracle
   * (`mcp-bearer-token.service.generate`) defaults `mcpUserId` to
   * `mcp:pat:<credential id>` in exactly that case, and the default is applied
   * HERE rather than in a transport because the credential id is minted here —
   * a transport that wanted to compose the same string would have to invent a
   * second id, and every token it minted for one entity would share a principal.
   * An `mcp-token` may not pass null: its principal is the operator, and the
   * domain refuses a mint without one.
   */
  readonly principalId: PrincipalId | null;
  /** The entity, for an `entity-bearer-token`. Null for an `mcp-token`. */
  readonly subjectId: string | null;
  /** `McpToken.tier`. Null for an `entity-bearer-token`. */
  readonly permissionTier: McpPermissionTier | null;
  /** Null means the ninety-day default both oracles use. */
  readonly ttlSeconds: number | null;
}

/**
 * What a mint hands back.
 *
 * `token` IS THE SECRET and this is the only place it appears. It is named
 * `token` rather than `secret` or `value` because that is the field name both
 * oracles return and every client already reads; renaming it would break the
 * one thing the legacy surface and this one must agree on.
 */
export interface MintedBearerCredentialView {
  readonly credentialId: string;
  readonly kind: MintableBearerKind;
  /** The raw bearer secret. Returned once; only its digest is stored. */
  readonly token: string;
  readonly label: string;
  readonly permissions: readonly string[];
  readonly permissionTier: McpPermissionTier | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/** The `TokenKind` whose prefix each mintable kind carries. */
function tokenKindOf(kind: MintableBearerKind): "mcpToken" | "entityBearerToken" {
  return kind === "mcp-token" ? "mcpToken" : "entityBearerToken";
}

export async function mintBearerCredential(
  ports: MintBearerCredentialPorts,
  command: MintBearerCredentialCommand,
): Promise<Result<MintedBearerCredentialView>> {
  const now = ports.clock.now();
  // MINTED BEFORE VALIDATION FAILS NOTHING AND COSTS NOTHING. The randomness is
  // discarded unread if the plan is refused, and generating it after the checks
  // would put the one call that can throw between the plan and the write.
  const raw = ports.minter.mint(tokenKindOf(command.kind));
  const credentialId = ports.ids.uuid();
  const plan = planBearerCredential({
    credentialId,
    kind: command.kind,
    tokenHash: ports.hasher.hash(raw) as TokenHash,
    scope: tenantAuthorizationScope(command.scope),
    label: command.label,
    permissions: command.permissions,
    createdByUserId: command.createdByUserId,
    principalId: command.principalId ?? (`mcp:pat:${credentialId}` as PrincipalId),
    subjectId: command.subjectId,
    permissionTier: command.permissionTier,
    ttlSeconds: command.ttlSeconds,
    now,
  });
  if (!plan.ok) return err(plan.error);

  let written: BearerCredentialRecord;
  try {
    written = await ports.repository.bearerCredentials.mint(plan.value);
  } catch (fault: unknown) {
    // THE MESSAGE, NEVER THE ERROR. A driver error object carries the connection
    // string, which carries the password, and `details` is rendered into logs —
    // the same rule `rateLimiterUnavailable` records for the limiter.
    const reason = fault instanceof Error ? fault.message : String(fault);
    ports.logger.log("warn", "identity.bearer_credential.mint_refused", {
      kind: command.kind,
      // NOT the label and NOT the permissions: a label is caller-chosen text and
      // a permission list is the shape of an access grant. The credential id is
      // enough to find the refused mint and carries nothing on its own.
      credentialId: plan.value.credentialId,
      reason,
    });
    return err(credentialMintRefused(reason));
  }

  return ok({
    credentialId: written.credentialId,
    kind: command.kind,
    token: raw,
    label: plan.value.label,
    // FROM THE WRITTEN ROW, not from the plan: what the store persisted is what
    // the credential will be verified against, and the two differ if a store
    // ever normalises a permission list.
    permissions: written.permissions,
    permissionTier: plan.value.permissionTier,
    // The plan's instant rather than the record's, because `BearerCredentialRecord`
    // types `expiresAt` as nullable for the kinds that can live forever and this
    // one never can.
    expiresAt: plan.value.expiresAt,
    // FROM THE PLAN, which is now the ONE place this instant is decided. It is
    // the same value `now` holds, and reading it from the plan is what makes the
    // row's own `createdAt` column — which the store writes from this same field
    // — provably the value returned here rather than a second clock's answer.
    createdAt: plan.value.createdAt,
  });
}
