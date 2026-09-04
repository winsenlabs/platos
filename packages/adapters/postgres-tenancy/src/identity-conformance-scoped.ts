// The tenant-SCOPED half of the identity conformance scenario: the environment
// access key, the OAuth pair and bearer credentials, and the end-user page.
//
// Split from `./identity-conformance.ts` by the ADR M0.3 §6 line budget, along
// the seam the scenario already had: everything here is keyed by a node of the
// tenant tree and everything there is keyed by a person. The driver in that file
// calls these three in order and they share its observation object, so the two
// halves are one comparison and not two.

import type {
  AccessKeyId,
  AccessKeyRecord,
  EnvironmentId,
  IdentityAccessRepository,
  OAuthTokenId,
  OperatorSessionId,
  OrganizationId,
  RotationFamilyId,
  TokenHash,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";

import type { IdentityConformanceIds, IdentityObservation } from "./identity-conformance.js";
import { AT, digest, EXPIRES, LATER } from "./identity-conformance.js";

function key(record: AccessKeyRecord | null): unknown {
  if (record === null) return null;
  return {
    accessKeyId: record.accessKeyId,
    keyPrefix: record.keyPrefix,
    keyHash: record.keyHash,
    allowedOrigins: [...record.allowedOrigins],
    validUntil: record.validUntil,
    replacedById: record.replacedById,
    revokedAt: record.revokedAt,
  };
}

export async function runAccessKeys(
  repository: IdentityAccessRepository,
  ids: IdentityConformanceIds,
  observed: IdentityObservation,
): Promise<void> {
  const environmentId = asIdentifier<EnvironmentId>(ids.environmentId);
  observed.generationBefore = await repository.accessKeys.readRevocationGeneration(
    environmentId,
  );
  observed.activeKeyBefore = key(await repository.accessKeys.findActiveKey(environmentId));

  const firstKey: AccessKeyRecord = {
    accessKeyId: asIdentifier<AccessKeyId>(ids.firstKeyId),
    environmentId,
    keyPrefix: "platos_live_aaa",
    keyHash: digest("11"),
    allowedOrigins: [],
    validUntil: null,
    replacedById: null,
    revokedAt: null,
    lastUsedAt: null,
  };
  observed.firstRotation = await repository.accessKeys.commitRotation({
    environmentId,
    plan: { nextKey: firstKey, retiringKey: null, overlapEndsAt: LATER },
    observedGeneration: 0,
  });
  observed.activeAfterFirst = key(await repository.accessKeys.findActiveKey(environmentId));

  const secondKey: AccessKeyRecord = {
    ...firstKey,
    accessKeyId: asIdentifier<AccessKeyId>(ids.secondKeyId),
    keyPrefix: "platos_live_bbb",
    keyHash: digest("22"),
  };
  observed.secondRotation = await repository.accessKeys.commitRotation({
    environmentId,
    plan: {
      nextKey: secondKey,
      retiringKey: { ...firstKey, validUntil: LATER, replacedById: secondKey.accessKeyId },
      overlapEndsAt: LATER,
    },
    observedGeneration: 0,
  });
  observed.activeAfterSecond = key(await repository.accessKeys.findActiveKey(environmentId));
  observed.retiredKey = key(await repository.accessKeys.findByHash(environmentId, digest("11")));
  observed.keyInWrongEnvironment = await repository.accessKeys.findByHash(
    asIdentifier<EnvironmentId>(ids.organizationId),
    digest("22"),
  );

  observed.revokedCount = await repository.accessKeys.revokeAll(environmentId, LATER);
  observed.generationAfterRevoke = await repository.accessKeys.readRevocationGeneration(
    environmentId,
  );
  observed.activeAfterRevoke = key(await repository.accessKeys.findActiveKey(environmentId));
  // The fence. A rotation that snapshotted generation 0 and reaches the lock
  // after a revoke has bumped it to 1 is REFUSED, and reports the generation it
  // saw so the caller can decide rather than guess.
  observed.supersededRotation = await repository.accessKeys.commitRotation({
    environmentId,
    plan: {
      nextKey: { ...firstKey, accessKeyId: asIdentifier<AccessKeyId>(ids.secondKeyId) },
      retiringKey: null,
      overlapEndsAt: LATER,
    },
    observedGeneration: 0,
  });
}

export async function runOAuthAndBearer(
  repository: IdentityAccessRepository,
  ids: IdentityConformanceIds,
  observed: IdentityObservation,
): Promise<void> {
  const codeHash = digest("33");
  observed.authorizationCode = await repository.oauth.findAuthorizationCodeByHash(codeHash);
  observed.consumeCode = await repository.oauth.consumeAuthorizationCode(codeHash, LATER);
  observed.consumeCodeAgain = await repository.oauth.consumeAuthorizationCode(codeHash, LATER);

  const scope = (await repository.oauth.findAuthorizationCodeByHash(codeHash))?.scope;
  if (scope !== undefined) {
    await repository.oauth.saveTokenPair({
      accessToken: {
        tokenId: asIdentifier<OAuthTokenId>(ids.accessTokenId),
        tokenHash: digest("44"),
        clientId: asIdentifier(ids.clientId),
        userId: asIdentifier<UserId>(ids.userId),
        scope,
        scopes: ["read"],
        issuedAt: AT,
        expiresAt: EXPIRES,
        revokedAt: null,
      },
      refreshToken: {
        tokenId: asIdentifier<OAuthTokenId>(ids.refreshTokenId),
        tokenHash: digest("55"),
        accessTokenId: asIdentifier<OAuthTokenId>(ids.accessTokenId),
        clientId: asIdentifier(ids.clientId),
        userId: asIdentifier<UserId>(ids.userId),
        scope,
        scopes: ["read"],
        rotationFamilyId: asIdentifier<RotationFamilyId>(ids.rotationFamilyId),
        parentRefreshTokenId: null,
        issuedAt: AT,
        expiresAt: EXPIRES,
        consumedAt: null,
        replayDetectedAt: null,
        revokedAt: null,
      },
      consumedRefreshToken: null,
      expiresInSeconds: 3600,
    });
  }
  const minted = await repository.oauth.findRefreshTokenByHash(digest("55"));
  // The SCOPE is the interesting column and the reason this step exists. On the
  // real store it was written as `scopeKind` plus ONE id and read back by
  // resolving the ancestors the row does not carry; on the fake it round-trips
  // as an object. They must produce the same value.
  observed.refreshToken = minted === null ? null : { ...minted, scope: minted.scope };
  observed.unknownRefreshToken = await repository.oauth.findRefreshTokenByHash(digest("66"));

  if (minted !== null) {
    await repository.oauth.saveTokenPair({
      accessToken: {
        tokenId: asIdentifier<OAuthTokenId>(ids.nextAccessTokenId),
        tokenHash: digest("77"),
        clientId: minted.clientId,
        userId: minted.userId,
        scope: minted.scope,
        scopes: ["read"],
        issuedAt: LATER,
        expiresAt: EXPIRES,
        revokedAt: null,
      },
      refreshToken: {
        ...minted,
        tokenId: asIdentifier<OAuthTokenId>(ids.nextRefreshTokenId),
        tokenHash: digest("88"),
        accessTokenId: asIdentifier<OAuthTokenId>(ids.nextAccessTokenId),
        parentRefreshTokenId: minted.tokenId,
        issuedAt: LATER,
      },
      consumedRefreshToken: { ...minted, consumedAt: LATER },
      expiresInSeconds: 3600,
    });
    observed.consumedRefreshToken = (
      await repository.oauth.findRefreshTokenByHash(digest("55"))
    )?.consumedAt;
    observed.familyRevoked = await repository.oauth.revokeRotationFamily({
      rotationFamilyId: minted.rotationFamilyId,
      replayDetectedAt: LATER,
      revokedAt: LATER,
    });
    observed.refreshAfterRevoke = (
      await repository.oauth.findRefreshTokenByHash(digest("88"))
    )?.revokedAt;
  }

  const mcpHash = asIdentifier<TokenHash>(ids.mcpTokenHash);
  const credential = await repository.bearerCredentials.findByTokenHash("mcp-token", mcpHash);
  observed.bearerCredential = credential;
  if (credential !== null) {
    await repository.bearerCredentials.save({ ...credential, lastUsedAt: LATER });
  }
  observed.bearerAfterTouch = await repository.bearerCredentials.findByTokenHash(
    "mcp-token",
    mcpHash,
  );
  observed.bearerUnknownDigest = await repository.bearerCredentials.findByTokenHash(
    "mcp-token",
    digest("99"),
  );
}

export async function runEndUsersAndAudit(
  repository: IdentityAccessRepository,
  ids: IdentityConformanceIds,
  observed: IdentityObservation,
): Promise<void> {
  const organizationId = asIdentifier<OrganizationId>(ids.organizationId);
  const base = { organizationId, status: null, search: null, limit: 25, offset: 0 } as const;
  observed.endUserPage = await repository.endUsers.list(base);
  observed.endUserTotal = await repository.endUsers.count(base);
  observed.activeOnly = await repository.endUsers.count({ ...base, status: "active" });
  observed.disabledOnly = await repository.endUsers.count({ ...base, status: "disabled" });
  // Case-insensitive, and it matches on an IDENTITY subject as well as on the
  // display name — which is the thing an operator actually has to search by.
  observed.searchByName = await repository.endUsers.count({ ...base, search: "ADA" });
  observed.searchBySubject = await repository.endUsers.count({ ...base, search: "slack-u" });
  observed.searchMiss = await repository.endUsers.count({ ...base, search: "nobody" });
  observed.secondPage = await repository.endUsers.list({ ...base, limit: 1, offset: 1 });
  // The tenant clause is not a filter. Another organization's rows are absent
  // whatever else is asked for.
  observed.otherTenant = await repository.endUsers.count({
    ...base,
    organizationId: asIdentifier<OrganizationId>(ids.environmentId),
  });

  await repository.impersonationAudit.append({
    action: "START",
    actorUserId: asIdentifier<UserId>(ids.userId),
    targetUserId: asIdentifier<UserId>(ids.userId),
    impersonationSessionId: asIdentifier<OperatorSessionId>(ids.sessionId),
    ipAddress: "203.0.113.7",
    userAgent: "conformance",
    recordedAt: AT,
  });
  await repository.impersonationAudit.append({
    action: "STOP",
    actorUserId: asIdentifier<UserId>(ids.userId),
    targetUserId: asIdentifier<UserId>(ids.userId),
    impersonationSessionId: asIdentifier<OperatorSessionId>(ids.sessionId),
    ipAddress: null,
    userAgent: null,
    recordedAt: LATER,
  });
  observed.auditAppended = "ok";
}
