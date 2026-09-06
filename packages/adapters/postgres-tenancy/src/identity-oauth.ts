// `OAuthStore` — the authorization code, the rotating refresh token, and the
// family revocation that answers a replay.
//
// SCOPE IS NOT IN THE ROW, AND THAT IS THE SCHEMA'S DOING. Each of these tables
// stores `scopeKind` plus three nullable ids, and the migrations'
// `OAuth*_scope_shape_check` requires EXACTLY ONE of them to be set. So a
// PROJECT-scoped token carries `projectId` and NOT `organizationId`, while the
// kernel's `ProjectScope` requires both. The ancestor is therefore SELECTED
// alongside the row through the relation, not fetched afterwards: a follow-up
// query per token is the N+1 this store is measured against, and the reads below
// are pinned at a constant statement count in
// `identity-statements.integration.test.ts`.
//
// THE FAMILY REVOCATION IS THE WHOLE POINT OF ROTATION. A refresh token is
// single-use; presenting a consumed one means the holder is not the only holder.
// The answer is not to refuse that one token but to revoke the entire rotation
// family and every access token minted from it, in one transaction, and to
// return how many rows that was so the caller can report the blast radius.

import type {
  FamilyRevocation,
  OAuthAuthorizationCodeRecord,
  OAuthRefreshTokenRecord,
  TokenHash,
  TokenPairPlan,
} from "@platos/context-identity-access/application/ports/index.js";
import type { OAuthStore } from "@platos/context-identity-access/application/ports/index.js";

import { requireDigest } from "./identity-guards.js";
import type { ScopeAncestry } from "./identity-mapping.js";
import { writeAuthorizationScope } from "./identity-mapping.js";
import { toAuthorizationCodeRecord, toRefreshTokenRecord } from "./identity-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The ancestor columns a scoped row needs and does not carry.
 *
 * `project.organizationId` for a project scope; `environment.projectId` and
 * `environment.project.organizationId` for an environment one. Selected in the
 * same call as the row, so resolving a scope costs no extra round trip that
 * grows with the number of rows read.
 */
const SCOPE_ANCESTORS = {
  project: { select: { organizationId: true } },
  environment: { select: { projectId: true, project: { select: { organizationId: true } } } },
} as const;

interface AncestorColumns {
  readonly project: { readonly organizationId: string } | null;
  readonly environment:
    | { readonly projectId: string; readonly project: { readonly organizationId: string } }
    | null;
}

function ancestryOf(row: AncestorColumns): ScopeAncestry {
  return {
    projectOrganizationId: row.project?.organizationId ?? null,
    environmentProjectId: row.environment?.projectId ?? null,
    environmentOrganizationId: row.environment?.project.organizationId ?? null,
  };
}

const SCOPE_COLUMNS = {
  scopeKind: true,
  organizationId: true,
  projectId: true,
  environmentId: true,
} as const;

const REFRESH_COLUMNS = {
  ...SCOPE_COLUMNS,
  ...SCOPE_ANCESTORS,
  id: true,
  tokenHash: true,
  accessTokenId: true,
  clientId: true,
  userId: true,
  scopes: true,
  rotationFamilyId: true,
  parentRefreshTokenId: true,
  issuedAt: true,
  expiresAt: true,
  consumedAt: true,
  replayDetectedAt: true,
  revokedAt: true,
} as const;

const CODE_COLUMNS = {
  ...SCOPE_COLUMNS,
  ...SCOPE_ANCESTORS,
  codeHash: true,
  clientId: true,
  userId: true,
  scopes: true,
  codeChallenge: true,
  codeChallengeMethod: true,
  redirectUri: true,
  expiresAt: true,
  usedAt: true,
} as const;

export function createOAuthStore(transactions: TenancyTransactions): OAuthStore {
  return {
    async findRefreshTokenByHash(tokenHash: TokenHash): Promise<OAuthRefreshTokenRecord | null> {
      const row = await transactions
        .reader()
        .oAuthRefreshToken.findUnique({ where: { tokenHash }, select: REFRESH_COLUMNS });
      return row === null ? null : toRefreshTokenRecord(row, ancestryOf(row));
    },

    async findAuthorizationCodeByHash(
      codeHash: TokenHash,
    ): Promise<OAuthAuthorizationCodeRecord | null> {
      const row = await transactions
        .reader()
        .oAuthAuthorizationCode.findUnique({ where: { codeHash }, select: CODE_COLUMNS });
      return row === null ? null : toAuthorizationCodeRecord(row, ancestryOf(row));
    },

    async consumeAuthorizationCode(codeHash: TokenHash, now: Date): Promise<boolean> {
      const result = await transactions.reader().oAuthAuthorizationCode.updateMany({
        where: { codeHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      return result.count === 1;
    },

    async saveTokenPair(plan: TokenPairPlan): Promise<void> {
      requireDigest("OAuthAccessToken.tokenHash", plan.accessToken.tokenHash);
      requireDigest("OAuthRefreshToken.tokenHash", plan.refreshToken.tokenHash);
      const accessScope = writeAuthorizationScope(plan.accessToken.scope);
      const refreshScope = writeAuthorizationScope(plan.refreshToken.scope);
      await transactions.atomic(async (client) => {
        await client.oAuthAccessToken.create({
          data: {
            id: plan.accessToken.tokenId,
            tokenHash: plan.accessToken.tokenHash,
            clientId: plan.accessToken.clientId,
            userId: plan.accessToken.userId,
            scopes: [...plan.accessToken.scopes],
            issuedAt: plan.accessToken.issuedAt,
            expiresAt: plan.accessToken.expiresAt,
            revokedAt: plan.accessToken.revokedAt,
            ...accessScope,
          },
        });
        await client.oAuthRefreshToken.create({
          data: {
            id: plan.refreshToken.tokenId,
            tokenHash: plan.refreshToken.tokenHash,
            accessTokenId: plan.refreshToken.accessTokenId,
            clientId: plan.refreshToken.clientId,
            userId: plan.refreshToken.userId,
            scopes: [...plan.refreshToken.scopes],
            rotationFamilyId: plan.refreshToken.rotationFamilyId,
            parentRefreshTokenId: plan.refreshToken.parentRefreshTokenId,
            issuedAt: plan.refreshToken.issuedAt,
            expiresAt: plan.refreshToken.expiresAt,
            consumedAt: plan.refreshToken.consumedAt,
            replayDetectedAt: plan.refreshToken.replayDetectedAt,
            revokedAt: plan.refreshToken.revokedAt,
            ...refreshScope,
          },
        });
        const consumed = plan.consumedRefreshToken;
        if (consumed === null) return;
        // CONDITIONAL, inside the same transaction as the mint. If the presented
        // token was consumed by a concurrent exchange between the read and here,
        // this affects zero rows, the guard below raises and the whole
        // transaction — including the new pair — rolls back. Marking it
        // unconditionally would let two exchanges of one refresh token both
        // succeed, which is the double-mint rotation exists to make detectable.
        const marked = await client.oAuthRefreshToken.updateMany({
          where: { id: consumed.tokenId, consumedAt: null },
          data: { consumedAt: consumed.consumedAt },
        });
        if (marked.count !== 1) {
          throw new Error(
            `OAuthRefreshToken ${consumed.tokenId} was consumed concurrently; the pair is rolled back`,
          );
        }
      });
    },

    async revokeRotationFamily(revocation: FamilyRevocation): Promise<number> {
      return transactions.atomic(async (client) => {
        // TWO statements, neither of which grows with the size of the family.
        // The access tokens are selected by a nested filter on the refresh
        // tokens that point at them, so no identifier list is round-tripped
        // through this process.
        const accessTokens = await client.oAuthAccessToken.updateMany({
          where: {
            revokedAt: null,
            refreshTokens: { some: { rotationFamilyId: revocation.rotationFamilyId } },
          },
          data: { revokedAt: revocation.revokedAt },
        });
        const refreshTokens = await client.oAuthRefreshToken.updateMany({
          where: { rotationFamilyId: revocation.rotationFamilyId, revokedAt: null },
          data: {
            revokedAt: revocation.revokedAt,
            replayDetectedAt: revocation.replayDetectedAt,
          },
        });
        return accessTokens.count + refreshTokens.count;
      });
    },
  };
}
