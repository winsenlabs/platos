// One scenario, written once, so the in-memory fake and this adapter can be
// asked the SAME questions and their answers compared.
//
// Same instrument as `./conformance.ts` is for tenancy, and the same reason: two
// independently written suites measure two things and agree by coincidence. This
// module drives one sequence of port calls and records what came back; a test
// runs it twice and compares verbatim. A divergence is then a named step with a
// value on each side.
//
// THE PORT IS NOT WRITE-COMPLETE, AND THE SCENARIO SAYS SO RATHER THAN HIDING
// IT. `EndUserStore` is read-only — `list` and `count`, no `save` — and
// `OAuthStore` can find and consume an authorization code but cannot mint one,
// and `BearerCredentialStore.save` updates a credential rather than creating
// one. Those rows are therefore created by a `seed` the caller supplies, which
// is a real fixture on the real store and a map write on the fake. That is not
// a gap in this scenario; it is the shape of the port, recorded here because it
// is the reason "run the same steps against both" needs a seam at all.
//
// NOTHING IS NORMALISED EXCEPT BIGINT. `lastUsedCounter` is a `bigint`, which
// has no JSON form, so it is recorded as a decimal string. Dates, counts,
// booleans, ordering and null-versus-absent all compare literally, and every
// identifier is supplied by the caller so neither store mints one.

import type {
  EmailAddress,
  IdentityAccessRepository,
  OperatorSessionId,
  TokenHash,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";

import {
  runAccessKeys,
  runEndUsersAndAudit,
  runOAuthAndBearer,
} from "./identity-conformance-scoped.js";

/** Every identifier the scenario needs, supplied so each store uses the same. */
export interface IdentityConformanceIds {
  readonly userId: string;
  readonly otherUserId: string;
  readonly sessionId: string;
  readonly secondSessionId: string;
  readonly environmentId: string;
  readonly organizationId: string;
  readonly firstKeyId: string;
  readonly secondKeyId: string;
  readonly clientId: string;
  readonly accessTokenId: string;
  readonly refreshTokenId: string;
  readonly nextAccessTokenId: string;
  readonly nextRefreshTokenId: string;
  readonly rotationFamilyId: string;
  readonly mcpTokenHash: string;
}

/**
 * A digest that satisfies every `*Hash` CHECK in the migrations.
 *
 * `^[0-9a-f]{64}$`, and a readable placeholder is refused. Tranche 1 found that
 * on its first integration run; this scenario is where the finding is kept.
 */
export const digest = (seed: string): TokenHash =>
  asIdentifier<TokenHash>(seed.repeat(64).slice(0, 64));

export const AT = new Date("2026-05-01T09:00:00.000Z");
export const LATER = new Date("2026-05-01T10:00:00.000Z");
export const EXPIRES = new Date("2026-05-08T09:00:00.000Z");

export type IdentityObservation = Record<string, unknown>;

export interface IdentityConformanceEnvironment {
  readonly repository: IdentityAccessRepository;
  readonly ids: IdentityConformanceIds;
  /**
   * Create the rows the PORT cannot: two end users with their identities, one
   * `McpToken`, and one OAuth client with one authorization code.
   */
  seed(): Promise<void>;
}

async function runUsers(
  repository: IdentityAccessRepository,
  ids: IdentityConformanceIds,
  observed: IdentityObservation,
): Promise<void> {
  const address = asIdentifier<EmailAddress>("conformance@example.test");
  const userId = asIdentifier<UserId>(ids.userId);
  observed.upsertUser = await repository.users.upsertByEmail(address, userId);
  // The SECOND call must return the row the first created, not a second row
  // under `otherUserId`. A get-or-create that created twice would be two
  // accounts for one address, which `User.email`'s UNIQUE index would refuse on
  // the real store and the fake would happily do.
  observed.upsertUserAgain = await repository.users.upsertByEmail(
    address,
    asIdentifier<UserId>(ids.otherUserId),
  );
  observed.findById = await repository.users.findById(userId);
  observed.findByEmail = await repository.users.findByEmail(address);
  observed.findMissingUser = await repository.users.findById(
    asIdentifier<UserId>(ids.otherUserId),
  );

  await repository.operatorIdentities.upsert({
    userId,
    provider: "GITHUB",
    subject: "gh-1",
    providerEmail: address,
  });
  observed.identityBySubject = await repository.operatorIdentities.findByProviderSubject(
    "GITHUB",
    "gh-1",
  );
  // The SAME (provider, subject) with a new provider address updates the row in
  // place and changes nothing else — `completeOAuthLogin`'s upsert exactly. A
  // store that keyed this on (userId, provider) instead would be performing a
  // re-bind, which is a different operation with a different failure mode; this
  // step is what told the first draft of the adapter it had picked the wrong
  // one of the table's two unique indexes.
  await repository.operatorIdentities.upsert({
    userId,
    provider: "GITHUB",
    subject: "gh-1",
    providerEmail: asIdentifier<EmailAddress>("rotated@example.test"),
  });
  observed.identityAfterEmailChange =
    await repository.operatorIdentities.findByProviderSubject("GITHUB", "gh-1");
  observed.identityAtUnknownSubject =
    await repository.operatorIdentities.findByProviderSubject("GITHUB", "gh-absent");
}

async function runSessions(
  repository: IdentityAccessRepository,
  ids: IdentityConformanceIds,
  observed: IdentityObservation,
): Promise<void> {
  const userId = asIdentifier<UserId>(ids.userId);
  const sessionId = asIdentifier<OperatorSessionId>(ids.sessionId);
  const tokenHash = digest("a1");
  await repository.operatorSessions.save({
    sessionId,
    tokenHash,
    tier: "OPERATOR",
    userId,
    impersonatedUserId: null,
    parentSessionId: null,
    mfaVerifiedAt: null,
    expiresAt: EXPIRES,
    revokedAt: null,
    lastSeenAt: null,
    createdAt: AT,
  });
  observed.sessionByToken = await repository.operatorSessions.findByTokenHash(tokenHash);
  observed.sessionById = await repository.operatorSessions.findById(sessionId);
  observed.sessionByUnknownToken = await repository.operatorSessions.findByTokenHash(
    digest("b2"),
  );

  const found = await repository.operatorSessions.findById(sessionId);
  if (found !== null) {
    await repository.operatorSessions.save({ ...found, lastSeenAt: LATER });
  }
  observed.sessionAfterTouch = await repository.operatorSessions.findById(sessionId);

  await repository.operatorSessions.save({
    sessionId: asIdentifier<OperatorSessionId>(ids.secondSessionId),
    tokenHash: digest("c3"),
    tier: "OPERATOR",
    userId,
    impersonatedUserId: null,
    parentSessionId: null,
    mfaVerifiedAt: null,
    expiresAt: EXPIRES,
    revokedAt: null,
    lastSeenAt: null,
    createdAt: AT,
  });
  observed.revokeAllExceptOne = await repository.operatorSessions.revokeAllForUser(
    userId,
    LATER,
    sessionId,
  );
  observed.survivingSession = (
    await repository.operatorSessions.findById(sessionId)
  )?.revokedAt;
  observed.revokedSibling = (
    await repository.operatorSessions.findById(
      asIdentifier<OperatorSessionId>(ids.secondSessionId),
    )
  )?.revokedAt;
  // The second sweep finds only the survivor, because the first already revoked
  // the other. A `revokeAllForUser` that ignored `revokedAt` would report two.
  observed.revokeAllAgain = await repository.operatorSessions.revokeAllForUser(userId, LATER);
}

async function runMagicLinksAndMfa(
  repository: IdentityAccessRepository,
  ids: IdentityConformanceIds,
  observed: IdentityObservation,
): Promise<void> {
  const userId = asIdentifier<UserId>(ids.userId);
  const linkHash = digest("d4");
  await repository.magicLinks.save({
    tokenHash: linkHash,
    email: asIdentifier<EmailAddress>("conformance@example.test"),
    expiresAt: EXPIRES,
    consumedAt: null,
    createdAt: AT,
  });
  observed.magicLink = await repository.magicLinks.findByTokenHash(linkHash);
  observed.firstConsume = await repository.magicLinks.consume(linkHash, LATER);
  // FALSE on the second call, by exact value. Two concurrent clicks on one
  // mailed link must produce one session and one refusal.
  observed.secondConsume = await repository.magicLinks.consume(linkHash, LATER);
  observed.magicLinkAfterConsume = await repository.magicLinks.findByTokenHash(linkHash);

  // An EXPIRED link cannot be consumed even by a caller that skipped the domain
  // check, because the expiry is in the conditional write's own WHERE clause. A
  // store that filtered only on `consumedAt` would answer true here and a link
  // left in a mailbox would be usable for ever.
  const staleHash = digest("f0");
  await repository.magicLinks.save({
    tokenHash: staleHash,
    email: asIdentifier<EmailAddress>("conformance@example.test"),
    expiresAt: AT,
    consumedAt: null,
    createdAt: AT,
  });
  observed.consumeExpired = await repository.magicLinks.consume(staleHash, LATER);
  observed.expiredLinkUntouched = (
    await repository.magicLinks.findByTokenHash(staleHash)
  )?.consumedAt;

  await repository.mfa.saveTotp({
    userId,
    encryptedSecret: null,
    enabledAt: null,
    lastUsedCounter: null,
    pendingEncryptedSecret: "pending-envelope",
    pendingExpiresAt: EXPIRES,
  });
  observed.pendingTotp = await repository.mfa.findTotp(userId);
  await repository.mfa.saveTotp({
    userId,
    encryptedSecret: "active-envelope",
    enabledAt: AT,
    lastUsedCounter: null,
    pendingEncryptedSecret: null,
    pendingExpiresAt: null,
  });
  observed.activeTotp = await repository.mfa.findTotp(userId);

  observed.advanceFirst = await repository.mfa.advanceTotpCounter(userId, 5n);
  // FALSE: the same code presented twice inside its 30-second step. This is the
  // replay the counter exists to stop, and it is a conditional UPDATE rather
  // than a read-then-write for exactly that reason.
  observed.advanceReplay = await repository.mfa.advanceTotpCounter(userId, 5n);
  observed.advanceOlder = await repository.mfa.advanceTotpCounter(userId, 4n);
  observed.advanceNewer = await repository.mfa.advanceTotpCounter(userId, 6n);
  const counter = (await repository.mfa.findTotp(userId))?.lastUsedCounter ?? null;
  observed.counterAfterAdvance = counter === null ? null : counter.toString();

  const first = digest("e5");
  const second = digest("f6");
  await repository.mfa.replaceRecoveryCodes(userId, [first, second]);
  observed.recoveryCode = await repository.mfa.findRecoveryCode(userId, first);
  observed.consumeRecovery = await repository.mfa.consumeRecoveryCode(userId, first, LATER);
  observed.consumeRecoveryAgain = await repository.mfa.consumeRecoveryCode(
    userId,
    first,
    LATER,
  );
  // Enrolment REPLACES the whole set, so a code from the previous set is gone
  // rather than merely consumed. An implementation that inserted without
  // deleting would still answer this one, which is a code the operator was told
  // was invalidated.
  await repository.mfa.replaceRecoveryCodes(userId, [digest("07")]);
  observed.recoveryAfterReplace = await repository.mfa.findRecoveryCode(userId, first);
  observed.newRecoveryCode = await repository.mfa.findRecoveryCode(userId, digest("07"));

  await repository.mfa.deleteTotp(userId);
  observed.totpAfterDelete = await repository.mfa.findTotp(userId);
  // Deleting a credential that is not there is not an error: the caller asked
  // for the row to be gone and it is gone.
  await repository.mfa.deleteTotp(userId);
  observed.deleteTotpTwice = "ok";
}

export async function runIdentityConformance(
  environment: IdentityConformanceEnvironment,
): Promise<IdentityObservation> {
  const { repository, ids } = environment;
  const observed: IdentityObservation = {};
  await runUsers(repository, ids, observed);
  await environment.seed();
  await runSessions(repository, ids, observed);
  await runMagicLinksAndMfa(repository, ids, observed);
  await runAccessKeys(repository, ids, observed);
  await runOAuthAndBearer(repository, ids, observed);
  await runEndUsersAndAudit(repository, ids, observed);
  return observed;
}
