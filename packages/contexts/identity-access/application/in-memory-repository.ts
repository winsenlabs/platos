// An in-memory IdentityAccessRepository.
//
// WIN-256's acceptance criterion is that a use case is invokable in memory. This
// is what makes that true: every store below is a Map, the whole suite runs with
// no database, no container and no network, and a test that wants "a revoked
// session" seeds one instead of arranging for one.
//
// IT IS A FAKE, NOT A MOCK. It implements the real behaviour — including the
// four conditional writes, which are the only interesting part of the contract —
// so a test asserts on outcomes rather than on which methods were called. A mock
// that records `advanceTotpCounter` was invoked proves nothing about replay; a
// fake that refuses the second call proves it.
//
// THE CONDITIONAL WRITES ARE IMPLEMENTED FAITHFULLY. `consume` on a magic link,
// `advanceTotpCounter`, `consumeRecoveryCode` and `commitRotation` each check
// their precondition and report whether they won, exactly as the SQL does. A
// fake that always returned true would let a use case that dropped its
// race-check keep passing, which is the failure mode this whole seam exists to
// prevent.

import type {
  AccessKeyRecord,
  BearerCredentialKind,
  BearerCredentialRecord,
  EmailAddress,
  FamilyRevocation,
  ImpersonationAuditEntry,
  MagicLinkTokenRecord,
  OAuthAuthorizationCodeRecord,
  OAuthRefreshTokenRecord,
  OperatorIdentityProvider,
  OperatorIdentityRecord,
  OperatorSessionId,
  OperatorSessionRecord,
  OperatorUserRecord,
  RecoveryCodeRecord,
  TokenHash,
  TokenPairPlan,
  TotpCredential,
  UserId,
} from "../domain/index.js";
import { isActive } from "../domain/index.js";
import type { AccessKeyRotationPlan } from "../domain/index.js";
import type { IdentityAccessRepository } from "./ports/index.js";
import type { EnvironmentId } from "@platos/kernel";

export interface InMemoryIdentityAccessRepository extends IdentityAccessRepository {
  readonly state: InMemoryState;
}

export interface InMemoryState {
  readonly users: Map<UserId, OperatorUserRecord>;
  readonly identities: Map<string, OperatorIdentityRecord>;
  readonly sessions: Map<OperatorSessionId, OperatorSessionRecord>;
  readonly magicLinks: Map<TokenHash, MagicLinkTokenRecord>;
  readonly totp: Map<UserId, TotpCredential>;
  readonly recoveryCodes: Map<string, RecoveryCodeRecord>;
  readonly accessKeys: Map<string, AccessKeyRecord>;
  readonly revocationGenerations: Map<EnvironmentId, number>;
  readonly refreshTokens: Map<TokenHash, OAuthRefreshTokenRecord>;
  readonly authorizationCodes: Map<TokenHash, OAuthAuthorizationCodeRecord>;
  readonly bearerCredentials: Map<string, BearerCredentialRecord>;
  readonly impersonationAudit: ImpersonationAuditEntry[];
}

function emptyState(): InMemoryState {
  return {
    users: new Map(),
    identities: new Map(),
    sessions: new Map(),
    magicLinks: new Map(),
    totp: new Map(),
    recoveryCodes: new Map(),
    accessKeys: new Map(),
    revocationGenerations: new Map(),
    refreshTokens: new Map(),
    authorizationCodes: new Map(),
    bearerCredentials: new Map(),
    impersonationAudit: [],
  };
}

const identityKey = (provider: OperatorIdentityProvider, subject: string): string =>
  `${provider}:${subject}`;
const recoveryKey = (userId: UserId, codeHash: string): string => `${userId}:${codeHash}`;
const bearerKey = (kind: BearerCredentialKind, tokenHash: string): string =>
  `${kind}:${tokenHash}`;

export function inMemoryIdentityAccessRepository(
  seed: Partial<InMemoryState> = {},
): InMemoryIdentityAccessRepository {
  const state: InMemoryState = { ...emptyState(), ...seed };

  return {
    state,

    users: {
      async findById(userId) {
        return state.users.get(userId) ?? null;
      },
      async findByEmail(address) {
        for (const user of state.users.values()) if (user.email === address) return user;
        return null;
      },
      async upsertByEmail(address: EmailAddress, newUserId: UserId) {
        for (const user of state.users.values()) if (user.email === address) return user;
        const created: OperatorUserRecord = {
          userId: newUserId,
          email: address,
          platformOperator: false,
          disabledAt: null,
        };
        state.users.set(newUserId, created);
        return created;
      },
    },

    operatorIdentities: {
      async findByProviderSubject(provider, subject) {
        return state.identities.get(identityKey(provider, subject)) ?? null;
      },
      async upsert(identity) {
        state.identities.set(identityKey(identity.provider, identity.subject), identity);
      },
    },

    operatorSessions: {
      async findByTokenHash(tokenHash) {
        for (const session of state.sessions.values()) {
          if (session.tokenHash === tokenHash) return session;
        }
        return null;
      },
      async findById(sessionId) {
        return state.sessions.get(sessionId) ?? null;
      },
      async save(session) {
        state.sessions.set(session.sessionId, session);
      },
      async revokeAllForUser(userId, now, exceptSessionId) {
        let count = 0;
        for (const [id, session] of state.sessions) {
          const affected = session.userId === userId || session.impersonatedUserId === userId;
          if (!affected || session.revokedAt !== null || id === exceptSessionId) continue;
          state.sessions.set(id, { ...session, revokedAt: now });
          count += 1;
        }
        return count;
      },
    },

    magicLinks: {
      async save(link) {
        state.magicLinks.set(link.tokenHash, link);
      },
      async findByTokenHash(tokenHash) {
        return state.magicLinks.get(tokenHash) ?? null;
      },
      // `UPDATE ... WHERE consumedAt IS NULL AND expiresAt > now`, row count 1.
      async consume(tokenHash, now) {
        const link = state.magicLinks.get(tokenHash);
        if (link === undefined || link.consumedAt !== null) return false;
        if (link.expiresAt.getTime() <= now.getTime()) return false;
        state.magicLinks.set(tokenHash, { ...link, consumedAt: now });
        return true;
      },
    },

    mfa: {
      async findTotp(userId) {
        return state.totp.get(userId) ?? null;
      },
      async saveTotp(credential) {
        state.totp.set(credential.userId, credential);
      },
      async deleteTotp(userId) {
        state.totp.delete(userId);
      },
      // `UPDATE ... WHERE lastUsedCounter IS NULL OR lastUsedCounter < counter`.
      async advanceTotpCounter(userId, counter) {
        const credential = state.totp.get(userId);
        if (credential === undefined) return false;
        if (credential.lastUsedCounter !== null && counter <= credential.lastUsedCounter) {
          return false;
        }
        state.totp.set(userId, { ...credential, lastUsedCounter: counter });
        return true;
      },
      async findRecoveryCode(userId, codeHash) {
        return state.recoveryCodes.get(recoveryKey(userId, codeHash)) ?? null;
      },
      // `UPDATE ... WHERE consumedAt IS NULL`, row count 1.
      async consumeRecoveryCode(userId, codeHash, now) {
        const key = recoveryKey(userId, codeHash);
        const code = state.recoveryCodes.get(key);
        if (code === undefined || code.consumedAt !== null) return false;
        state.recoveryCodes.set(key, { ...code, consumedAt: now });
        return true;
      },
      async replaceRecoveryCodes(userId, codeHashes) {
        for (const key of [...state.recoveryCodes.keys()]) {
          if (key.startsWith(`${userId}:`)) state.recoveryCodes.delete(key);
        }
        for (const codeHash of codeHashes) {
          state.recoveryCodes.set(recoveryKey(userId, codeHash), {
            userId,
            codeHash,
            consumedAt: null,
          });
        }
      },
    },

    accessKeys: {
      async findActiveKey(environmentId) {
        for (const key of state.accessKeys.values()) {
          if (key.environmentId === environmentId && isActive(key)) return key;
        }
        return null;
      },
      async findByHash(environmentId, keyHash) {
        for (const key of state.accessKeys.values()) {
          if (key.environmentId === environmentId && key.keyHash === keyHash) return key;
        }
        return null;
      },
      async readRevocationGeneration(environmentId) {
        return state.revocationGenerations.get(environmentId) ?? null;
      },
      // The lock, the fence and the two writes, in the order the SQL does them.
      async commitRotation({ environmentId, plan, observedGeneration }) {
        const generation = state.revocationGenerations.get(environmentId) ?? 0;
        if (generation !== observedGeneration) return { committed: false, generation };
        applyRotation(state, plan);
        return { committed: true, generation };
      },
      async revokeAll(environmentId, now) {
        let count = 0;
        for (const [id, key] of state.accessKeys) {
          if (key.environmentId !== environmentId || key.revokedAt !== null) continue;
          state.accessKeys.set(id, { ...key, revokedAt: now });
          count += 1;
        }
        state.revocationGenerations.set(
          environmentId,
          (state.revocationGenerations.get(environmentId) ?? 0) + 1,
        );
        return count;
      },
    },

    oauth: {
      async findRefreshTokenByHash(tokenHash) {
        return state.refreshTokens.get(tokenHash) ?? null;
      },
      async findAuthorizationCodeByHash(codeHash) {
        return state.authorizationCodes.get(codeHash) ?? null;
      },
      async consumeAuthorizationCode(codeHash, now) {
        const code = state.authorizationCodes.get(codeHash);
        if (code === undefined || code.usedAt !== null) return false;
        if (code.expiresAt.getTime() <= now.getTime()) return false;
        state.authorizationCodes.set(codeHash, { ...code, usedAt: now });
        return true;
      },
      async saveTokenPair(plan: TokenPairPlan) {
        if (plan.consumedRefreshToken !== null) {
          state.refreshTokens.set(
            plan.consumedRefreshToken.tokenHash,
            plan.consumedRefreshToken,
          );
        }
        state.refreshTokens.set(plan.refreshToken.tokenHash, plan.refreshToken);
      },
      async revokeRotationFamily(revocation: FamilyRevocation) {
        let count = 0;
        for (const [hash, token] of state.refreshTokens) {
          if (token.rotationFamilyId !== revocation.rotationFamilyId) continue;
          state.refreshTokens.set(hash, {
            ...token,
            replayDetectedAt: revocation.replayDetectedAt,
            revokedAt: revocation.revokedAt,
          });
          count += 1;
        }
        return count;
      },
    },

    bearerCredentials: {
      async findByTokenHash(kind, tokenHash) {
        return state.bearerCredentials.get(bearerKey(kind, tokenHash)) ?? null;
      },
      async save(credential) {
        state.bearerCredentials.set(
          bearerKey(credential.kind, credential.tokenHash),
          credential,
        );
      },
    },

    impersonationAudit: {
      async append(entry) {
        state.impersonationAudit.push(entry);
      },
    },
  };
}

function applyRotation(state: InMemoryState, plan: AccessKeyRotationPlan): void {
  if (plan.retiringKey !== null) {
    state.accessKeys.set(plan.retiringKey.accessKeyId, plan.retiringKey);
  }
  state.accessKeys.set(plan.nextKey.accessKeyId, plan.nextKey);
}
