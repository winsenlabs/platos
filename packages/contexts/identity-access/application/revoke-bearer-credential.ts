// Use case: END one MCP bearer credential, and report which of three things was
// true when the call arrived.
//
// WIN-268 (M4.2). `POST /mcp/platform/tokens/:id/revoke` and
// `DELETE /mcp/entity/:entityId/tokens/:tokenId` are in the generated operation
// manifest with an `apps/agent` implementation and nothing in `apps/core-api`.
// This is the contract method the two V1 routes reach.
//
// -----------------------------------------------------------------------------
// THE THREE OPERATOR STORIES, AND WHY ONLY ONE OF THEM IS A REFUSAL
//
//   NEVER EXISTED      -> `CREDENTIAL_NOT_FOUND`. The id is wrong or belongs to
//                         another environment. The only refusal here.
//   ALREADY REVOKED    -> success, `previousState: "revoked"`, and the ORIGINAL
//                         `revokedAt` preserved.
//   LAPSED ON ITS OWN  -> success, `previousState: "expired"`. The row is ended
//                         anyway, so a lapsed credential can be put beyond use
//                         for good rather than left to be re-read as "expired".
//
// WHY THE SECOND IS NOT A REFUSAL, AND THIS IS NOT A PREFERENCE.
// `apps/core-api/src/http/idempotency-policy.ts` classes both routes `exempt` and
// records WHY in the tree: "Revocation, not a mint. It is naturally idempotent —
// a token revoked twice is revoked". A use case that refused the second call
// would falsify a recorded exemption and leave two routes idempotency-exempt
// while not being idempotent. The legacy oracles agree (`if (existing.revokedAt)
// return true;`), so nothing is being extracted differently either.
//
// WHAT IS NEW IS THAT THE THREE ARE DISTINGUISHABLE AT ALL. Both oracles return
// `Promise<boolean>` — `false` for absent, `true` for revoked-now AND for
// already-revoked — so an operator could not tell a mistyped id from a second
// click, or a decision from a clock. `previousState` and `newlyRevoked` are that
// distinction, computed from the row rather than from the request.
//
// -----------------------------------------------------------------------------
// THE INSTANT AND THE ROW ARE THE STORE'S
//
// `revokedAt` on the view is read back from the row AFTER the write, which is the
// bar `revokeOperatorSession` set for server-side sign-out: "the instant the store
// now holds, not the instant the caller asked". `newlyRevoked` comes from the
// CONDITIONAL update's own row count, so two operators revoking at once see one
// `true` and one `false` and both read the winner's instant — rather than the
// second overwriting the first and destroying when the credential was really
// ended.
//
// AND REVOKING IS NOT THE SAME AS DELETING. The row survives, `revokedAt` set, so
// `authenticateBearer` answers `CREDENTIAL_REVOKED` — a decision somebody made —
// where a deleted row would answer `UNAUTHENTICATED` and read to the holder as a
// typo they could retry. `domain/credential.ts` fixes that ordering once for every
// credential in this context.

import { err, ok, type Result } from "@platos/kernel";

import {
  credentialNotFound,
  credentialRevocationNotApplied,
  credentialStateAt,
  planBearerCredentialRevocation,
  type AuthorizationScope,
  type CredentialState,
  type MintableBearerKind,
} from "../domain/index.js";
import type { PortsOf } from "./dependencies.js";

export type RevokeBearerCredentialPorts = PortsOf<"repository" | "clock">;

export interface RevokeBearerCredentialInput {
  readonly kind: MintableBearerKind;
  readonly credentialId: string;
  /** Already authorized. Never an environment id read off a request. */
  readonly scope: AuthorizationScope;
  /** The entity, for an entity token. Refused for a platform token. */
  readonly subjectId: string | null;
  /** The operator ending it. Recorded where the table has a column for it. */
  readonly revokedByUserId: string | null;
}

export interface RevokedBearerCredential {
  readonly credentialId: string;
  readonly kind: MintableBearerKind;
  readonly label: string;
  /** The instant the ROW holds. Never the instant this call asked. */
  readonly revokedAt: Date;
  /** True when THIS call made the transition; false when it was already ended. */
  readonly newlyRevoked: boolean;
  /**
   * What the credential was immediately before this call.
   *
   * Computed from the row's own `expiresAt` against the instant that was written,
   * so "expired" means the clock had run out rather than that somebody guessed.
   * Never `"active"` and `newlyRevoked: false` together — that pair would say the
   * row was live and untouched, which no branch below can produce.
   */
  readonly previousState: CredentialState;
  /** `McpToken.revokedBy` as the row now holds it; null for an entity token. */
  readonly revokedBy: string | null;
}

export async function revokeBearerCredential(
  ports: RevokeBearerCredentialPorts,
  input: RevokeBearerCredentialInput,
): Promise<Result<RevokedBearerCredential>> {
  const plan = planBearerCredentialRevocation({
    kind: input.kind,
    credentialId: input.credentialId,
    scope: input.scope,
    subjectId: input.subjectId,
    revokedByUserId: input.revokedByUserId,
    now: ports.clock.now(),
  });
  if (!plan.ok) return err(plan.error);

  const outcome = await ports.repository.bearerCredentials.revoke(plan.value);
  if (outcome === null) return err(credentialNotFound(input.credentialId));

  const { credential, newlyRevoked } = outcome;
  if (credential.revokedAt === null) {
    // THE STORE REPORTED A ROW IT DID NOT END. Its OWN code and not
    // `CREDENTIAL_NOT_FOUND`: the row is there, so "no such credential" would be
    // false, and `error-taxonomy.mjs` rule E6 refuses one function raising one code
    // from two guards nothing at runtime can tell apart. It is refused loudly
    // rather than reported as a revocation that happened — an operator told a
    // credential is dead while it still authenticates is the outcome this route
    // exists to prevent.
    return err(credentialRevocationNotApplied(input.credentialId));
  }
  return ok({
    credentialId: credential.credentialId,
    kind: credential.kind,
    label: credential.label,
    revokedAt: credential.revokedAt,
    newlyRevoked,
    // THE STATE THE ROW WAS IN, RECONSTRUCTED FROM THE ROW. Asking
    // `credentialStateAt` about a row whose `revokedAt` is now set would answer
    // `"revoked"` for every case, so the revocation is lifted off before asking —
    // and only when this call is the one that set it.
    previousState: newlyRevoked
      ? credentialStateAt({ expiresAt: credential.expiresAt, revokedAt: null }, plan.value.revokedAt)
      : "revoked",
    revokedBy: credential.revokedBy,
  });
}
