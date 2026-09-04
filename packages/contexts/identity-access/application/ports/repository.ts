// IdentityAccessRepository — the canonical-store seam for the rows ADR M0.3 §1
// makes this context the SOLE WRITER of.
//
// It is a composite of narrow stores rather than one flat interface with fifty
// methods, for three reasons. A use case declares the stores it touches, so
// "what does authenticating a session read?" is answerable from a signature. A
// test fake is assembled from the pieces the test needs. And the store
// boundaries are the ownership boundaries, so a reviewer can check the
// sole-writer map against this file directly.
//
// CONDITIONAL WRITES ARE PART OF THE CONTRACT, NOT AN OPTIMISATION.
// Four methods below return a boolean rather than void: `consume` on a magic
// link, `advanceTotpCounter`, `consumeRecoveryCode`, `commitRotation`. In every
// case the boolean answers "was I the one that won?", and in every case the
// alternative — read, decide, write — is a race that admits a double-spend of a
// single-use credential. The extraction source implements each of them as an
// UPDATE with the precondition in its WHERE clause and a row-count check, and an
// implementation of this port must do something equivalent.
//
// TRANSACTIONS. Multi-row use cases run inside the kernel `UnitOfWork`; the
// stores take no transaction handle because ADR M0.3 §3 forbids passing a vendor
// transaction across a port. The adapter correlates on the ambient
// `TransactionScope`.

import type {
  AccessKeyRecord,
  AccessKeyRotationPlan,
  BearerCredentialKind,
  BearerCredentialRecord,
  EmailAddress,
  EndUserQuery,
  EndUserWithIdentities,
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
} from "../../domain/index.js";
import type { EnvironmentId } from "@platos/kernel";

export interface UserStore {
  findById(userId: UserId): Promise<OperatorUserRecord | null>;
  findByEmail(address: EmailAddress): Promise<OperatorUserRecord | null>;
  /**
   * Get-or-create by address. Login mints the account on first successful proof
   * of the address, so there is no separate registration step to keep in sync.
   */
  upsertByEmail(address: EmailAddress, newUserId: UserId): Promise<OperatorUserRecord>;
}

export interface OperatorIdentityStore {
  findByProviderSubject(
    provider: OperatorIdentityProvider,
    subject: string,
  ): Promise<OperatorIdentityRecord | null>;
  upsert(identity: OperatorIdentityRecord): Promise<void>;
}

export interface OperatorSessionStore {
  findByTokenHash(tokenHash: TokenHash): Promise<OperatorSessionRecord | null>;
  findById(sessionId: OperatorSessionId): Promise<OperatorSessionRecord | null>;
  save(session: OperatorSessionRecord): Promise<void>;
  /**
   * Revoke every live session for a user, returning how many were ended.
   *
   * Called when privileges change and when a second factor is enrolled or
   * removed: a credential minted under the old facts must not outlive them.
   */
  revokeAllForUser(userId: UserId, now: Date, exceptSessionId?: OperatorSessionId): Promise<number>;
}

export interface MagicLinkStore {
  save(link: MagicLinkTokenRecord): Promise<void>;
  findByTokenHash(tokenHash: TokenHash): Promise<MagicLinkTokenRecord | null>;
  /** Conditional consume. False when a concurrent click already won. */
  consume(tokenHash: TokenHash, now: Date): Promise<boolean>;
}

export interface OperatorMfaStore {
  findTotp(userId: UserId): Promise<TotpCredential | null>;
  saveTotp(credential: TotpCredential): Promise<void>;
  deleteTotp(userId: UserId): Promise<void>;
  /**
   * Move `lastUsedCounter` forward, conditional on it being null or strictly
   * less than `counter`. False means somebody else used this code first — which
   * is exactly the replay the counter exists to stop.
   */
  advanceTotpCounter(userId: UserId, counter: bigint): Promise<boolean>;
  findRecoveryCode(userId: UserId, codeHash: TokenHash): Promise<RecoveryCodeRecord | null>;
  /** Conditional consume, on `consumedAt IS NULL`. */
  consumeRecoveryCode(userId: UserId, codeHash: TokenHash, now: Date): Promise<boolean>;
  /** Replace the whole set. Enrolment invalidates every previously issued code. */
  replaceRecoveryCodes(userId: UserId, codeHashes: readonly TokenHash[]): Promise<void>;
}

export interface AccessKeyStore {
  /** The single key with `validUntil IS NULL AND revokedAt IS NULL`, if any. */
  findActiveKey(environmentId: EnvironmentId): Promise<AccessKeyRecord | null>;
  findByHash(environmentId: EnvironmentId, keyHash: TokenHash): Promise<AccessKeyRecord | null>;
  /**
   * The environment's revocation generation, read WITHOUT the lock.
   *
   * Snapshotted before a rotation queues for the lock, so a revoke that starts
   * afterwards still dominates: the rotation sees a changed generation under the
   * lock and refuses.
   */
  readRevocationGeneration(environmentId: EnvironmentId): Promise<number | null>;
  /**
   * Persist a rotation under the environment row lock.
   *
   * Returns the generation observed UNDER the lock. The caller compares it with
   * the snapshot via `assertGenerationUnchanged`, so the fence rule stays in the
   * domain and only the locking is the adapter's.
   */
  commitRotation(input: {
    readonly environmentId: EnvironmentId;
    readonly plan: AccessKeyRotationPlan;
    readonly observedGeneration: number;
  }): Promise<{ readonly committed: boolean; readonly generation: number }>;
  /** Revoke every key and bump the generation. Returns how many were revoked. */
  revokeAll(environmentId: EnvironmentId, now: Date): Promise<number>;
}

export interface OAuthStore {
  findRefreshTokenByHash(tokenHash: TokenHash): Promise<OAuthRefreshTokenRecord | null>;
  findAuthorizationCodeByHash(codeHash: TokenHash): Promise<OAuthAuthorizationCodeRecord | null>;
  /** Conditional consume, on `usedAt IS NULL AND expiresAt > now`. */
  consumeAuthorizationCode(codeHash: TokenHash, now: Date): Promise<boolean>;
  /** Write the new pair and mark the presented refresh token consumed. */
  saveTokenPair(plan: TokenPairPlan): Promise<void>;
  /**
   * Revoke an entire rotation family and every access token linked to it.
   * Returns the number of rows revoked, for the safety observation.
   */
  revokeRotationFamily(revocation: FamilyRevocation): Promise<number>;
}

export interface BearerCredentialStore {
  findByTokenHash(
    kind: BearerCredentialKind,
    tokenHash: TokenHash,
  ): Promise<BearerCredentialRecord | null>;
  save(credential: BearerCredentialRecord): Promise<void>;
}

/**
 * The read side of `EndUser`, and the only one.
 *
 * It takes a VALIDATED `EndUserQuery` rather than loose parameters, so the
 * organization on it came from an authorized scope and an implementation has no
 * decision left to make about which tenant it is answering for. Both methods
 * take the same query: a `total` computed under different filtering from the
 * page it describes is a pagination control that lies.
 */
export interface EndUserStore {
  list(query: EndUserQuery): Promise<readonly EndUserWithIdentities[]>;
  /** Rows matching the query IGNORING `limit` and `offset`. */
  count(query: EndUserQuery): Promise<number>;
}

export interface ImpersonationAuditStore {
  /** Append-only. There is no update and no delete. */
  append(entry: ImpersonationAuditEntry): Promise<void>;
}

export interface IdentityAccessRepository {
  readonly users: UserStore;
  readonly operatorIdentities: OperatorIdentityStore;
  readonly operatorSessions: OperatorSessionStore;
  readonly magicLinks: MagicLinkStore;
  readonly mfa: OperatorMfaStore;
  readonly accessKeys: AccessKeyStore;
  readonly oauth: OAuthStore;
  readonly bearerCredentials: BearerCredentialStore;
  readonly endUsers: EndUserStore;
  readonly impersonationAudit: ImpersonationAuditStore;
}
