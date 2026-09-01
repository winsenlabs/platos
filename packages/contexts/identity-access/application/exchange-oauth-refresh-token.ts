// Exchange a refresh token for a new pair — and detect a replay.
//
// THE ORDER IS THE SECURITY MODEL.
//
//   1. unknown token          -> invalid_grant, no side effect
//   2. wrong client           -> invalid_grant, no side effect
//   3. wrong scope            -> invalid_grant, no side effect
//   4. already spent/revoked  -> REVOKE THE ENTIRE ROTATION FAMILY
//   5. expired                -> invalid_grant, no side effect
//   6. otherwise              -> consume it and mint the next pair
//
// Steps 2 and 3 come BEFORE step 4 deliberately. A caller who does not own the
// token must not be able to destroy its family: putting the replay check first
// would hand any stranger holding a leaked hash a one-request denial of service
// against the legitimate client.
//
// Step 4 is the only place in this context where one request invalidates
// credentials the caller did not present. When a spent token comes back, two
// parties hold it and the request cannot say which is calling, so both are cut
// off and sent back through the authorization endpoint where a human is. The
// linked access tokens go too — leaving them alive would give the thief an hour.
//
// A REPLAY IS A SAFETY EVENT. It is reported through the kernel sink, which is
// how `governance` learns about it without identity-access importing it.

import {
  assertIssuedToClient,
  assertScopeMatches,
  classifyRefreshToken,
  familyRevocation,
  invalidGrant,
  planTokenPair,
  tokenReplayed,
  type OAuthClientId,
  type OAuthTokenId,
  type TokenPairPlan,
} from "../domain/index.js";
import type { PortsOf } from "./dependencies.js";
import { asIdentifier, err, ok, type Result, type TenantScope } from "@platos/kernel";

export type ExchangeRefreshTokenPorts = PortsOf<
  "repository" | "hasher" | "minter" | "clock" | "ids" | "safety"
>;

export interface ExchangeRefreshTokenInput {
  readonly clientId: OAuthClientId;
  readonly presentedToken: string;
  /** The scope the token endpoint was addressed at, when it is scoped. */
  readonly expectedScope?: TenantScope;
}

export interface ExchangedTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly scopes: readonly string[];
  readonly plan: TokenPairPlan;
}

const REPLAY_RULE = "identity.oauth.refresh_token_replayed";

export async function exchangeOAuthRefreshToken(
  ports: ExchangeRefreshTokenPorts,
  input: ExchangeRefreshTokenInput,
): Promise<Result<ExchangedTokenPair>> {
  const now = ports.clock.now();
  const store = ports.repository.oauth;
  const presented = await store.findRefreshTokenByHash(ports.hasher.hash(input.presentedToken));
  if (presented === null) return err(invalidGrant("refresh_token not found"));

  const owned = assertIssuedToClient(presented, input.clientId);
  if (!owned.ok) return err(owned.error);
  const scoped = assertScopeMatches(presented, input.expectedScope ?? null);
  if (!scoped.ok) return err(scoped.error);

  const verdict = classifyRefreshToken(presented, now);
  if (verdict.kind === "replay") {
    const revocation = familyRevocation(verdict.rotationFamilyId, now);
    const revokedCount = await store.revokeRotationFamily(revocation);
    // The kernel sink requires a tenant scope. A GLOBAL grant has none, and
    // inventing one would attribute the event to a tenant that did not produce
    // it — so the revocation still happens and only the observation is skipped.
    if (presented.scope.kind !== "GLOBAL") {
      await ports.safety.record({
        rule: REPLAY_RULE,
        outcome: "blocked",
        scope: presented.scope.tenant,
        principalId: null,
        observedAt: now,
        details: { rotationFamilyId: verdict.rotationFamilyId, revokedCount },
      });
    }
    return err(tokenReplayed());
  }
  if (verdict.kind === "expired") return err(invalidGrant("refresh_token expired"));

  const accessToken = ports.minter.mint("oauthAccessToken");
  const refreshToken = ports.minter.mint("oauthRefreshToken");
  const plan = planTokenPair({
    accessTokenId: asIdentifier<OAuthTokenId>(ports.ids.uuid()),
    accessTokenHash: ports.hasher.hash(accessToken),
    refreshTokenId: asIdentifier<OAuthTokenId>(ports.ids.uuid()),
    refreshTokenHash: ports.hasher.hash(refreshToken),
    clientId: presented.clientId,
    userId: presented.userId,
    scope: presented.scope,
    scopes: presented.scopes,
    // The family identifier is INHERITED, never regenerated: it is what lets a
    // replay four rotations later still reach every token in the chain.
    rotationFamilyId: presented.rotationFamilyId,
    parent: presented,
    now,
  });
  await store.saveTokenPair(plan);

  return ok({
    accessToken,
    refreshToken,
    expiresInSeconds: plan.expiresInSeconds,
    scopes: plan.accessToken.scopes,
    plan,
  });
}
