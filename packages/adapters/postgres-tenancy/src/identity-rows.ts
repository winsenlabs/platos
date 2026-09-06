// The structural row shapes of the twenty-three identity-access rows, and the
// pure row -> record mappers over them.
//
// SPLIT OUT OF `./identity-mapping.ts` BY THE ADR M0.3 §6 LINE BUDGET, not by a
// change of concern: the refusals live next door because they are the decisions,
// and this file is the transcription. A mapper here validates nothing on its own
// — it calls the readers in `./identity-mapping.js` for every column that has a
// value set to defend.
//
// The row types are STRUCTURAL rather than generated, for the reason
// `./mapping.ts` states: a suite that could only run after `prisma generate`
// is a suite nobody runs. They are checked against the generated types where the
// stores call these functions, so a schema change still breaks the build.

import type {
  AccessKeyId,
  AccessKeyRecord,
  AuthorizationScope,
  BearerCredentialKind,
  BearerCredentialRecord,
  EmailAddress,
  EndUserId,
  EndUserIdentityId,
  EndUserIdentityRecord,
  EndUserRecord,
  EnvironmentId,
  MagicLinkTokenRecord,
  OAuthAuthorizationCodeRecord,
  OAuthClientId,
  OAuthRefreshTokenRecord,
  OAuthTokenId,
  OperatorIdentityRecord,
  OperatorSessionId,
  OperatorSessionRecord,
  OperatorUserRecord,
  OrganizationId,
  PrincipalId,
  PrincipalTier,
  RecoveryCodeRecord,
  RotationFamilyId,
  TokenHash,
  TotpCredential,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";

import type { ScopeAncestry, ScopeColumns } from "./identity-mapping.js";
import { readAuthorizationScope, readIdentityProvider, readIdentityTier } from "./identity-mapping.js";

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly platformOperator: boolean;
  readonly disabledAt: Date | null;
}

export interface OperatorIdentityRow {
  readonly userId: string;
  readonly provider: string;
  readonly subject: string;
  readonly providerEmail: string;
}

export interface OperatorSessionRow {
  readonly id: string;
  readonly tokenHash: string;
  readonly tier: string;
  readonly userId: string;
  readonly impersonatedUserId: string | null;
  readonly parentSessionId: string | null;
  readonly mfaVerifiedAt: Date | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
}

export interface MagicLinkRow {
  readonly tokenHash: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface TotpRow {
  readonly userId: string;
  readonly encryptedSecret: string | null;
  readonly enabledAt: Date | null;
  readonly lastUsedCounter: bigint | null;
  readonly pendingEncryptedSecret: string | null;
  readonly pendingExpiresAt: Date | null;
}

export interface RecoveryCodeRow {
  readonly userId: string;
  readonly codeHash: string;
  readonly consumedAt: Date | null;
}

export interface AccessKeyRow {
  readonly id: string;
  readonly environmentId: string;
  readonly keyPrefix: string;
  readonly keyHash: string;
  readonly allowedOrigins: readonly string[];
  readonly validUntil: Date | null;
  readonly replacedById: string | null;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
}

export interface OAuthRefreshTokenRow extends ScopeColumns {
  readonly id: string;
  readonly tokenHash: string;
  readonly accessTokenId: string | null;
  readonly clientId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly rotationFamilyId: string;
  readonly parentRefreshTokenId: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly replayDetectedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface OAuthAuthorizationCodeRow extends ScopeColumns {
  readonly codeHash: string;
  readonly clientId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly redirectUri: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface EndUserRow {
  readonly id: string;
  readonly organizationId: string;
  readonly displayName: string | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
}

export interface EndUserIdentityRow {
  readonly id: string;
  readonly endUserId: string;
  readonly issuer: string;
  readonly channel: string;
  readonly subject: string;
  readonly verifiedAt: Date | null;
  readonly disabledAt: Date | null;
}

// --- row -> record ----------------------------------------------------------

export function toUserRecord(row: UserRow): OperatorUserRecord {
  return {
    userId: asIdentifier<UserId>(row.id),
    email: asIdentifier<EmailAddress>(row.email),
    platformOperator: row.platformOperator,
    disabledAt: row.disabledAt,
  };
}

export function toOperatorIdentityRecord(row: OperatorIdentityRow): OperatorIdentityRecord {
  return {
    userId: asIdentifier<UserId>(row.userId),
    provider: readIdentityProvider(row.provider),
    subject: row.subject,
    providerEmail: asIdentifier<EmailAddress>(row.providerEmail),
  };
}

export function toOperatorSessionRecord(row: OperatorSessionRow): OperatorSessionRecord {
  return {
    sessionId: asIdentifier<OperatorSessionId>(row.id),
    tokenHash: asIdentifier<TokenHash>(row.tokenHash),
    tier: readIdentityTier("OperatorSession.tier", row.tier),
    userId: asIdentifier<UserId>(row.userId),
    impersonatedUserId:
      row.impersonatedUserId === null ? null : asIdentifier<UserId>(row.impersonatedUserId),
    parentSessionId:
      row.parentSessionId === null ? null : asIdentifier<OperatorSessionId>(row.parentSessionId),
    mfaVerifiedAt: row.mfaVerifiedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

export function toMagicLinkRecord(row: MagicLinkRow): MagicLinkTokenRecord {
  return {
    tokenHash: asIdentifier<TokenHash>(row.tokenHash),
    email: asIdentifier<EmailAddress>(row.email),
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  };
}

export function toTotpCredential(row: TotpRow): TotpCredential {
  return {
    userId: asIdentifier<UserId>(row.userId),
    encryptedSecret: row.encryptedSecret,
    enabledAt: row.enabledAt,
    lastUsedCounter: row.lastUsedCounter,
    pendingEncryptedSecret: row.pendingEncryptedSecret,
    pendingExpiresAt: row.pendingExpiresAt,
  };
}

export function toRecoveryCodeRecord(row: RecoveryCodeRow): RecoveryCodeRecord {
  return {
    userId: asIdentifier<UserId>(row.userId),
    codeHash: row.codeHash,
    consumedAt: row.consumedAt,
  };
}

export function toAccessKeyRecord(row: AccessKeyRow): AccessKeyRecord {
  return {
    accessKeyId: asIdentifier<AccessKeyId>(row.id),
    environmentId: asIdentifier<EnvironmentId>(row.environmentId),
    keyPrefix: row.keyPrefix,
    keyHash: asIdentifier<TokenHash>(row.keyHash),
    allowedOrigins: [...row.allowedOrigins],
    validUntil: row.validUntil,
    replacedById:
      row.replacedById === null ? null : asIdentifier<AccessKeyId>(row.replacedById),
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export function toRefreshTokenRecord(
  row: OAuthRefreshTokenRow,
  ancestry: ScopeAncestry = {},
): OAuthRefreshTokenRecord {
  return {
    tokenId: asIdentifier<OAuthTokenId>(row.id),
    tokenHash: asIdentifier<TokenHash>(row.tokenHash),
    accessTokenId:
      row.accessTokenId === null ? null : asIdentifier<OAuthTokenId>(row.accessTokenId),
    clientId: asIdentifier<OAuthClientId>(row.clientId),
    userId: asIdentifier<UserId>(row.userId),
    scope: readAuthorizationScope(row, ancestry, "OAuthRefreshToken"),
    scopes: [...row.scopes],
    rotationFamilyId: asIdentifier<RotationFamilyId>(row.rotationFamilyId),
    parentRefreshTokenId:
      row.parentRefreshTokenId === null
        ? null
        : asIdentifier<OAuthTokenId>(row.parentRefreshTokenId),
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    replayDetectedAt: row.replayDetectedAt,
    revokedAt: row.revokedAt,
  };
}

export function toAuthorizationCodeRecord(
  row: OAuthAuthorizationCodeRow,
  ancestry: ScopeAncestry = {},
): OAuthAuthorizationCodeRecord {
  return {
    codeHash: asIdentifier<TokenHash>(row.codeHash),
    clientId: asIdentifier<OAuthClientId>(row.clientId),
    userId: asIdentifier<UserId>(row.userId),
    scope: readAuthorizationScope(row, ancestry, "OAuthAuthorizationCode"),
    scopes: [...row.scopes],
    codeChallenge: row.codeChallenge,
    codeChallengeMethod: row.codeChallengeMethod,
    redirectUri: row.redirectUri,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
  };
}

export function toEndUserRecord(row: EndUserRow): EndUserRecord {
  return {
    endUserId: asIdentifier<EndUserId>(row.id),
    organizationId: asIdentifier<OrganizationId>(row.organizationId),
    displayName: row.displayName,
    disabledAt: row.disabledAt,
    createdAt: row.createdAt,
  };
}

export function toEndUserIdentityRecord(
  row: EndUserIdentityRow,
  endUserId: string,
): EndUserIdentityRecord {
  return {
    identityId: asIdentifier<EndUserIdentityId>(row.id),
    endUserId: asIdentifier<EndUserId>(endUserId),
    issuer: row.issuer,
    channel: row.channel,
    subject: row.subject,
    verifiedAt: row.verifiedAt,
    disabledAt: row.disabledAt,
  };
}

/** Widen a row identifier into the kernel's cross-cutting principal identity. */
export function toPrincipalId(value: string): PrincipalId {
  return asIdentifier<PrincipalId>(value);
}

export function toBearerCredentialRecord(input: {
  readonly credentialId: string;
  readonly kind: BearerCredentialKind;
  readonly tokenHash: string;
  readonly tier: PrincipalTier;
  readonly principalId: string;
  readonly scope: AuthorizationScope;
  readonly permissions: readonly string[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
}): BearerCredentialRecord {
  return {
    credentialId: input.credentialId,
    kind: input.kind,
    tokenHash: asIdentifier<TokenHash>(input.tokenHash),
    tier: input.tier,
    principalId: toPrincipalId(input.principalId),
    scope: input.scope,
    permissions: [...input.permissions],
    expiresAt: input.expiresAt,
    revokedAt: input.revokedAt,
    lastUsedAt: input.lastUsedAt,
  };
}
