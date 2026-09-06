// The shared apparatus for the two `PlatosAuthService` differential suites.
//
// It is a module rather than a copy in each file because the two suites have to
// be comparing the same thing: one clock, one hasher, one snapshot shape. It was
// split out when `identity-differential.integration.test.ts` crossed the ADR
// M0.3 §6 hard limit of 500 effective lines — the budget pointing at a real
// seam, so the file was split along it rather than the limit raised.
//
// THE HASHER IS THE REAL ONE, and that is the load-bearing detail.
// `application/testing.ts`'s `fakeSecretHasher` prepends a string, which is
// deterministic and injective and therefore fine for a unit suite — and is
// refused by `OperatorSession_tokenHash_check`. Against a real database the
// hasher has to be the function the oracle uses, or the two sides are not
// writing comparable rows.

import { createHash, randomBytes } from "node:crypto";

import { PlatosAuthService, hashSecret } from "@platos/tenancy-database";
import {
  authenticateOperator,
  completeMagicLinkLogin,
  issueOperatorSession,
  revokeOperatorSession,
  startMagicLinkLogin,
} from "@platos/context-identity-access/application/index.js";
import {
  fakeMfaSecretCipher,
  fakeRateLimiter,
  fakeTotpCodeVerifier,
  fixedClock,
  recordingSafetySink,
  silentLogger,
} from "@platos/context-identity-access/application/index.js";
import type {
  OrganizationId,
  TokenHash,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";
import type { IdentityAccessPorts } from "@platos/context-identity-access/application/index.js";

import type { IdentityHarness, SeededTenant } from "./identity-harness.js";
import { startIdentityHarness } from "./identity-harness.js";

export let harness: IdentityHarness;
export let tenant: SeededTenant;
export let ports: IdentityAccessPorts;
export let oracle: PlatosAuthService;

export const NOW = new Date("2026-05-01T09:00:00.000Z");
const ENCRYPTION_KEY = "07".repeat(32);

/**
 * The REAL digest, not the test double's.
 *
 * `application/testing.ts`'s `fakeSecretHasher` prepends a string, which is
 * deterministic and injective and therefore perfectly adequate for a unit
 * suite — and is refused by `OperatorSession_tokenHash_check`. Against a real
 * database the hasher has to be the one the oracle uses, or the two sides are
 * not writing comparable rows.
 */
export const realHasher = {
  hash: (value: string): TokenHash =>
    asIdentifier<TokenHash>(createHash("sha256").update(value, "utf8").digest("hex")),
  matches: (value: string, digest: TokenHash): boolean =>
    createHash("sha256").update(value, "utf8").digest("hex") === digest,
};

let minted = 0;
export function opaque(prefix: string): string {
  minted += 1;
  return `${prefix}${randomBytes(24).toString("base64url")}${String(minted)}`;
}

const realMinter = {
  mint: (kind: string): string =>
    (
      opaque(kind === "magicLink" ? "plt_ml_" : kind === "operatorSession" ? "plt_os_" : "plt_")
    ),
  mintTotpSecret: (): string => randomBytes(20).toString("hex").toUpperCase(),
  mintRecoveryCodes: (count: number): readonly string[] =>
    Array.from({ length: count }, () => opaque("rc_")),
};

let uuidSequence = 0;
export const uuids = {
  uuid: (): string => {
    uuidSequence += 1;
    return `cccccccc-0000-4000-8000-${String(uuidSequence).padStart(12, "0")}`;
  },
  ulid: (): string => `01ARZ3NDEKTSV4RRFFQ69G5F${String(uuidSequence).padStart(2, "0")}`,
};

export async function startDifferential(): Promise<void> {
  harness = await startIdentityHarness();
  tenant = await harness.seedTenant("differential");
  const clock = fixedClock(NOW);
  ports = {
    repository: harness.repository,
    rateLimiter: fakeRateLimiter(),
    hasher: realHasher as never,
    minter: realMinter as never,
    totp: fakeTotpCodeVerifier(),
    cipher: fakeMfaSecretCipher(),
    clock,
    ids: uuids as never,
    safety: recordingSafetySink(),
    logger: silentLogger(),
  };
  oracle = new PlatosAuthService(harness.client as never, {
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
    tokenGenerator: opaque,
  });
}

export async function stopDifferential(): Promise<void> {
  await harness?.stop();
}

export interface Snapshot {
  readonly sessions: readonly unknown[];
  readonly identities: readonly unknown[];
  readonly magicLinks: readonly unknown[];
  readonly totp: unknown;
  readonly recoveryCodeCount: number;
  readonly audit: readonly unknown[];
}

/** Millisecond offset from the one instant both sides were given. */
const offset = (value: Date | null): number | null =>
  value === null ? null : value.getTime() - NOW.getTime();

/**
 * Every identity-access row belonging to `subject`, with the values that CANNOT
 * agree replaced by stable labels and everything else left literal.
 *
 * The labels are assigned in a deterministic order — sessions by `createdAt`
 * then `id` — so two runs that produced the same shape produce the same
 * snapshot, and one that produced an extra row does not.
 */
export async function snapshot(subject: string, address: string): Promise<Snapshot> {
  const sessionRows = await harness.client.operatorSession.findMany({
    where: { OR: [{ userId: subject }, { impersonatedUserId: subject }] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const label = new Map<string, string>();
  sessionRows.forEach((row, index) => label.set(row.id, `<session-${String(index + 1)}>`));
  return {
    sessions: sessionRows.map((row) => ({
      id: label.get(row.id),
      digestLength: row.tokenHash.length,
      digestIsHex: /^[0-9a-f]{64}$/u.test(row.tokenHash),
      tier: row.tier,
      isActor: row.userId === subject,
      impersonates: row.impersonatedUserId === null ? null : "<user>",
      parent: row.parentSessionId === null ? null : label.get(row.parentSessionId),
      mfaVerifiedAt: offset(row.mfaVerifiedAt),
      expiresAt: offset(row.expiresAt),
      revokedAt: offset(row.revokedAt),
      lastSeenAt: offset(row.lastSeenAt),
      // `createdAt` is compared as PRESENT rather than by value, and that is a
      // recorded DIVERGENCE rather than a convenience. See the dedicated case
      // "the one behavioural divergence" below: the oracle lets the column
      // default stamp it from the DATABASE clock, and V1 writes the instant its
      // injected `Clock` gave the use case. Every other column here compares
      // literally.
      createdAtIsSet: row.createdAt !== null,
    })),
    identities: (
      await harness.client.operatorIdentity.findMany({
        where: { userId: subject },
        orderBy: [{ provider: "asc" }, { subject: "asc" }],
      })
    ).map((row) => ({
      provider: row.provider,
      subjectIsAddress: row.subject === address,
      providerEmail: row.providerEmail === address ? "<address>" : row.providerEmail,
    })),
    magicLinks: (
      await harness.client.magicLinkToken.findMany({
        where: { email: address },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    ).map((row) => ({
      digestIsHex: /^[0-9a-f]{64}$/u.test(row.tokenHash),
      expiresAt: offset(row.expiresAt),
      consumedAt: offset(row.consumedAt),
    })),
    totp: await harness.client.operatorMfaTotp
      .findUnique({ where: { userId: subject } })
      .then((row) =>
        row === null
          ? null
          : {
              hasSecret: row.encryptedSecret !== null,
              enabledAt: offset(row.enabledAt),
              lastUsedCounter: row.lastUsedCounter === null ? null : row.lastUsedCounter.toString(),
              hasPending: row.pendingEncryptedSecret !== null,
              pendingExpiresAt: offset(row.pendingExpiresAt),
            },
      ),
    recoveryCodeCount: await harness.client.operatorMfaRecoveryCode.count({
      where: { userId: subject },
    }),
    audit: (
      await harness.client.impersonationAudit.findMany({
        where: { OR: [{ actorUserId: subject }, { targetUserId: subject }] },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    ).map((row) => ({
      action: row.action,
      isActor: row.actorUserId === subject,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
    })),
  };
}

/** A pair of operators, one for each side, created identically. */
export async function pair(name: string): Promise<{ oracleUser: string; v1User: string }> {
  const oracleAddress = `oracle-${name}@example.test`;
  const v1Address = `v1-${name}@example.test`;
  const oracleUser = await harness.client.user
    .create({ data: { email: oracleAddress } })
    .then((row) => row.id);
  const v1User = await harness.repository.users
    .upsertByEmail(asIdentifier(v1Address), asIdentifier<UserId>(uuids.uuid()))
    .then((row) => row.userId);
  await harness.seedMembership(tenant.organizationId, oracleUser);
  await harness.seedMembership(tenant.organizationId, v1User);
  return { oracleUser, v1User };
}
