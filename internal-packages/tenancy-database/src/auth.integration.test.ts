import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ImpersonationAction,
  OperatorIdentityProvider,
  OrganizationRole,
  PrismaClient,
} from "../generated/control";
import { generateTotp, hashSecret, PlatosAuthError, PlatosAuthService } from "./auth";

const encryptionKey = "0123456789abcdef0123456789abcdef";

function expectAuthError(code: string) {
  const statuses: Record<string, number> = {
    unauthorized: 401,
    expired: 401,
    revoked: 401,
    mfa_required: 401,
    invalid_mfa: 401,
    invite_invalid: 401,
    forbidden: 403,
    invite_email_mismatch: 403,
    impersonation_forbidden: 403,
    invite_consumed: 409,
    rate_limited: 429,
  };
  return expect.objectContaining({ name: "PlatosAuthError", code, status: statuses[code] });
}

describe("Platos-native auth integration", () => {
  let container: StartedPostgreSqlContainer;
  let database: PrismaClient;
  let now: Date;
  let auth: PlatosAuthService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    execFileSync(
      resolve(process.cwd(), "node_modules/.bin/prisma"),
      ["migrate", "deploy", "--schema", resolve(process.cwd(), "prisma/schema.prisma")],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      }
    );
    database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    now = new Date("2026-08-14T12:00:00.000Z");
    auth = new PlatosAuthService(database, { encryptionKey, now: () => now });
  }, 120_000);

  afterAll(async () => {
    await database?.$disconnect();
    await container?.stop();
  });

  test("issues, verifies, expires, revokes, and organization-authorizes opaque sessions", async () => {
    const user = await database.user.create({ data: { email: "matrix@example.test" } });
    const organization = await database.organization.create({
      data: { slug: "auth-matrix", name: "Auth matrix" },
    });
    const otherOrganization = await database.organization.create({
      data: { slug: "auth-matrix-other", name: "Other" },
    });
    const membership = await database.organizationMembership.create({
      data: { organizationId: organization.id, userId: user.id, role: OrganizationRole.ADMIN },
    });

    await expect(auth.authorizeOperatorSession(null, organization.id)).rejects.toEqual(
      expectAuthError("unauthorized")
    );
    await expect(auth.authorizeOperatorSession("bad-token", organization.id)).rejects.toEqual(
      expectAuthError("unauthorized")
    );

    const valid = await auth.issueOperatorSession({ userId: user.id });
    await expect(
      auth.authorizeOperatorSession(valid.token, organization.id)
    ).resolves.toMatchObject({
      actorUserId: user.id,
      effectiveUserId: user.id,
      role: OrganizationRole.ADMIN,
      impersonation: null,
    });
    await expect(auth.authorizeOperatorSession(valid.token, otherOrganization.id)).rejects.toEqual(
      expectAuthError("forbidden")
    );

    const expiring = await auth.issueOperatorSession({
      userId: user.id,
      expiresAt: new Date(now.getTime() + 1_000),
    });
    now = new Date(now.getTime() + 1_001);
    await expect(auth.authorizeOperatorSession(expiring.token)).rejects.toEqual(
      expectAuthError("expired")
    );

    const roleChangeSession = await auth.issueOperatorSession({ userId: user.id });
    await database.organizationMembership.update({
      where: { id: membership.id },
      data: { role: OrganizationRole.MEMBER },
    });
    await expect(auth.authorizeOperatorSession(roleChangeSession.token)).rejects.toEqual(
      expectAuthError("revoked")
    );

    const removalSession = await auth.issueOperatorSession({ userId: user.id });
    await database.organizationMembership.delete({ where: { id: membership.id } });
    await expect(auth.authorizeOperatorSession(removalSession.token)).rejects.toEqual(
      expectAuthError("revoked")
    );
  });

  test("consumes hashed, expiring magic links once and retains GitHub/Google identities", async () => {
    const link = await auth.issueMagicLink({
      email: "Magic@Example.Test",
      rateLimitIdentifier: "magic@example.test:127.0.0.1",
    });
    const login = await auth.consumeMagicLink(link.token);
    expect(login.token).toMatch(/^plt_os_/);
    await expect(auth.consumeMagicLink(link.token)).rejects.toEqual(
      expectAuthError("unauthorized")
    );
    await expect(
      database.magicLinkToken.findUnique({
        where: {
          id: (
            await database.magicLinkToken.findFirstOrThrow({
              where: { email: "magic@example.test" },
            })
          ).id,
        },
      })
    ).resolves.toMatchObject({ consumedAt: expect.any(Date) });

    const github = await auth.completeOAuthLogin({
      provider: OperatorIdentityProvider.GITHUB,
      subject: "github-42",
      email: "oauth@example.test",
      emailVerified: true,
      rateLimitIdentifier: "github:127.0.0.1",
    });
    const google = await auth.completeOAuthLogin({
      provider: OperatorIdentityProvider.GOOGLE,
      subject: "google-42",
      email: "oauth@example.test",
      emailVerified: true,
      rateLimitIdentifier: "google:127.0.0.1",
    });
    expect(google.userId).toBe(github.userId);
    await expect(
      database.operatorIdentity.count({ where: { userId: github.userId } })
    ).resolves.toBe(2);
  });

  test("enrols TOTP, verifies a later code, and consumes recovery codes once", async () => {
    const user = await database.user.create({ data: { email: "mfa@example.test" } });
    const enrollment = await auth.beginTotpEnrollment(user.id);
    const setupCode = generateTotp(enrollment.secret, now);
    const { recoveryCodes } = await auth.confirmTotpEnrollment(
      user.id,
      setupCode,
      "mfa-enrollment:127.0.0.1"
    );
    expect(recoveryCodes).toHaveLength(9);

    const totpSession = await auth.issueOperatorSession({ userId: user.id });
    await expect(auth.authorizeOperatorSession(totpSession.token)).rejects.toEqual(
      expectAuthError("mfa_required")
    );
    now = new Date(now.getTime() + 30_000);
    const loginCode = generateTotp(enrollment.secret, now);
    await auth.verifyMfaForSession({
      sessionToken: totpSession.token,
      rateLimitIdentifier: "mfa-login:127.0.0.1",
      totpCode: loginCode,
    });
    await expect(auth.authorizeOperatorSession(totpSession.token)).resolves.toMatchObject({
      mfaVerifiedAt: now,
    });

    const replaySession = await auth.issueOperatorSession({ userId: user.id });
    await expect(
      auth.verifyMfaForSession({
        sessionToken: replaySession.token,
        rateLimitIdentifier: "mfa-replay:127.0.0.1",
        totpCode: loginCode,
      })
    ).rejects.toEqual(expectAuthError("invalid_mfa"));

    const recoverySession = await auth.issueOperatorSession({ userId: user.id });
    await auth.verifyMfaForSession({
      sessionToken: recoverySession.token,
      rateLimitIdentifier: "mfa-recovery:127.0.0.1",
      recoveryCode: recoveryCodes[0],
    });
    const recoveryReplaySession = await auth.issueOperatorSession({ userId: user.id });
    await expect(
      auth.verifyMfaForSession({
        sessionToken: recoveryReplaySession.token,
        rateLimitIdentifier: "mfa-recovery-replay:127.0.0.1",
        recoveryCode: recoveryCodes[0],
      })
    ).rejects.toEqual(expectAuthError("invalid_mfa"));

    await auth.disableTotpForSession({
      sessionToken: recoverySession.token,
      rateLimitIdentifier: "mfa-disable:127.0.0.1",
      recoveryCode: recoveryCodes[1],
    });
    await expect(
      database.operatorMfaTotp.findUnique({ where: { userId: user.id } })
    ).resolves.toBeNull();
    await expect(
      database.operatorMfaRecoveryCode.count({ where: { userId: user.id } })
    ).resolves.toBe(0);
    await expect(auth.authorizeOperatorSession(recoverySession.token)).resolves.toMatchObject({
      effectiveUserId: user.id,
      mfaVerifiedAt: null,
    });
    await expect(auth.authorizeOperatorSession(totpSession.token)).rejects.toEqual(
      expectAuthError("revoked")
    );
  });

  test("does not disable MFA when concurrent revocation wins the session lock", async () => {
    const user = await database.user.create({ data: { email: "mfa-revoke-race@example.test" } });
    const enrollment = await auth.beginTotpEnrollment(user.id);
    const { recoveryCodes } = await auth.confirmTotpEnrollment(
      user.id,
      generateTotp(enrollment.secret, now),
      "mfa-revoke-race-enrollment"
    );
    const issued = await auth.issueOperatorSession({ userId: user.id });
    const session = await database.operatorSession.findUniqueOrThrow({
      where: { tokenHash: hashSecret(issued.token) },
    });

    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const revocation = database.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "OperatorSession"
        WHERE "id" = ${session.id}::uuid
        FOR UPDATE
      `;
      await tx.operatorSession.update({
        where: { id: session.id },
        data: { revokedAt: now },
      });
      signalLocked();
      await release;
    });

    await locked;
    const disable = auth.disableTotpForSession({
      sessionToken: issued.token,
      rateLimitIdentifier: "mfa-revoke-race-session",
      recoveryCode: recoveryCodes[0],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseLock();
    await revocation;

    await expect(disable).rejects.toEqual(expectAuthError("unauthorized"));
    await expect(
      database.operatorMfaTotp.findUnique({ where: { userId: user.id } })
    ).resolves.not.toBeNull();
    await expect(
      database.operatorMfaRecoveryCode.count({
        where: { userId: user.id, consumedAt: { not: null } },
      })
    ).resolves.toBe(0);
  });

  test("rolls back recovery consumption when the disable transition fails", async () => {
    const user = await database.user.create({ data: { email: "mfa-disable-rollback@example.test" } });
    const enrollment = await auth.beginTotpEnrollment(user.id);
    const { recoveryCodes } = await auth.confirmTotpEnrollment(
      user.id,
      generateTotp(enrollment.secret, now),
      "mfa-disable-rollback-enrollment"
    );
    const issued = await auth.issueOperatorSession({ userId: user.id });

    await database.$executeRawUnsafe(`
      CREATE FUNCTION fail_mfa_factor_delete() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced MFA factor deletion failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await database.$executeRawUnsafe(`
      CREATE TRIGGER fail_mfa_factor_delete
      BEFORE DELETE ON "OperatorMfaTotp"
      FOR EACH ROW EXECUTE FUNCTION fail_mfa_factor_delete()
    `);
    try {
      await expect(
        auth.disableTotpForSession({
          sessionToken: issued.token,
          rateLimitIdentifier: "mfa-disable-rollback-session",
          recoveryCode: recoveryCodes[0],
        })
      ).rejects.toThrow("forced MFA factor deletion failure");
    } finally {
      await database.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS fail_mfa_factor_delete ON "OperatorMfaTotp"`
      );
      await database.$executeRawUnsafe(`DROP FUNCTION IF EXISTS fail_mfa_factor_delete()`);
    }

    await expect(
      database.operatorMfaTotp.findUnique({ where: { userId: user.id } })
    ).resolves.not.toBeNull();
    await expect(
      database.operatorMfaRecoveryCode.count({
        where: { userId: user.id, consumedAt: { not: null } },
      })
    ).resolves.toBe(0);
    await expect(
      auth.disableTotpForSession({
        sessionToken: issued.token,
        rateLimitIdentifier: "mfa-disable-rollback-session",
        recoveryCode: recoveryCodes[0],
      })
    ).resolves.toBeUndefined();
  });

  test("keeps active MFA usable during re-enrollment and rate limits online verification", async () => {
    const user = await database.user.create({ data: { email: "mfa-reenroll@example.test" } });
    const initial = await auth.beginTotpEnrollment(user.id);
    await auth.confirmTotpEnrollment(
      user.id,
      generateTotp(initial.secret, now),
      "mfa-initial-enrollment:127.0.0.1"
    );
    const activeBefore = await database.operatorMfaTotp.findUniqueOrThrow({
      where: { userId: user.id },
    });

    const replacement = await auth.beginTotpEnrollment(user.id);
    const pending = await database.operatorMfaTotp.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(pending.encryptedSecret).toBe(activeBefore.encryptedSecret);
    expect(pending.enabledAt).toEqual(activeBefore.enabledAt);
    expect(pending.pendingEncryptedSecret).not.toBeNull();

    await expect(
      auth.confirmTotpEnrollment(user.id, "000000", "mfa-reenroll-invalid:127.0.0.1")
    ).rejects.toEqual(expectAuthError("invalid_mfa"));
    await expect(
      database.operatorMfaTotp.findUniqueOrThrow({ where: { userId: user.id } })
    ).resolves.toMatchObject({
      encryptedSecret: activeBefore.encryptedSecret,
      enabledAt: activeBefore.enabledAt,
    });

    const oldCredentialSession = await auth.issueOperatorSession({ userId: user.id });
    now = new Date(now.getTime() + 30_000);
    await expect(
      auth.verifyMfaForSession({
        sessionToken: oldCredentialSession.token,
        rateLimitIdentifier: "mfa-old-credential:127.0.0.1",
        totpCode: generateTotp(initial.secret, now),
      })
    ).resolves.toBeUndefined();

    const sessionRevokedOnReplacement = await auth.issueOperatorSession({ userId: user.id });
    await auth.confirmTotpEnrollment(
      user.id,
      generateTotp(replacement.secret, now),
      "mfa-reenroll-confirm:127.0.0.1"
    );
    const activeAfter = await database.operatorMfaTotp.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(activeAfter.encryptedSecret).not.toBe(activeBefore.encryptedSecret);
    expect(activeAfter.pendingEncryptedSecret).toBeNull();
    await expect(auth.authorizeOperatorSession(sessionRevokedOnReplacement.token)).rejects.toEqual(
      expectAuthError("revoked")
    );

    const limited = new PlatosAuthService(database, {
      encryptionKey,
      now: () => now,
      mfaVerifyRateLimit: { requests: 1, windowMs: 60_000 },
    });
    const limitedSession = await limited.issueOperatorSession({ userId: user.id });
    await expect(
      limited.verifyMfaForSession({
        sessionToken: limitedSession.token,
        rateLimitIdentifier: "mfa-limited:127.0.0.1",
        totpCode: "000000",
      })
    ).rejects.toEqual(expectAuthError("invalid_mfa"));
    await expect(
      limited.verifyMfaForSession({
        sessionToken: limitedSession.token,
        rateLimitIdentifier: "mfa-limited:127.0.0.1",
        totpCode: "000000",
      })
    ).rejects.toEqual(expectAuthError("rate_limited"));
  });

  test("binds invitation tokens to normalized email and prevents replay", async () => {
    const inviter = await database.user.create({ data: { email: "inviter@example.test" } });
    const invitee = await database.user.create({ data: { email: "invitee@example.test" } });
    const other = await database.user.create({ data: { email: "other@example.test" } });
    const organization = await database.organization.create({
      data: { slug: "invitations", name: "Invitations" },
    });
    await database.organizationMembership.create({
      data: { organizationId: organization.id, userId: inviter.id, role: OrganizationRole.OWNER },
    });
    const invitation = await auth.issueInvitation({
      organizationId: organization.id,
      inviterId: inviter.id,
      email: "Invitee@Example.Test",
      role: OrganizationRole.ADMIN,
    });

    await expect(
      auth.acceptInvitation({
        token: invitation.token,
        userId: other.id,
        email: other.email,
        rateLimitIdentifier: "invite-other:127.0.0.1",
      })
    ).rejects.toEqual(expectAuthError("invite_email_mismatch"));

    await expect(
      auth.acceptInvitation({
        token: invitation.token,
        userId: invitee.id,
        email: "INVITEE@example.test",
        rateLimitIdentifier: "invitee:127.0.0.1",
      })
    ).resolves.toEqual({ organizationId: organization.id, role: OrganizationRole.ADMIN });

    await expect(
      auth.acceptInvitation({
        token: invitation.token,
        userId: invitee.id,
        email: invitee.email,
        rateLimitIdentifier: "invitee:127.0.0.1",
      })
    ).rejects.toEqual(expectAuthError("invite_consumed"));
  });

  test("serializes concurrent invitation replacement to one active token", async () => {
    const inviter = await database.user.create({
      data: { email: "concurrent-inviter@example.test" },
    });
    const organization = await database.organization.create({
      data: { slug: "concurrent-invitations", name: "Concurrent invitations" },
    });
    const [first, second] = await Promise.all([
      auth.issueInvitation({
        organizationId: organization.id,
        inviterId: inviter.id,
        email: "Concurrent@Example.Test",
      }),
      auth.issueInvitation({
        organizationId: organization.id,
        inviterId: inviter.id,
        email: "concurrent@example.test",
      }),
    ]);

    expect(first.invitationId).not.toBe(second.invitationId);
    await expect(
      database.organizationInvitation.count({
        where: {
          organizationId: organization.id,
          email: "concurrent@example.test",
          acceptedAt: null,
          revokedAt: null,
        },
      })
    ).resolves.toBe(1);
  });

  test("rate limits login and invitation acceptance with persisted hashed identifiers", async () => {
    const limited = new PlatosAuthService(database, {
      encryptionKey,
      now: () => now,
      loginRateLimit: { requests: 1, windowMs: 60_000 },
    });
    await limited.issueMagicLink({
      email: "limited@example.test",
      rateLimitIdentifier: "limited@example.test:127.0.0.1",
    });
    await expect(
      limited.issueMagicLink({
        email: "limited@example.test",
        rateLimitIdentifier: "limited@example.test:127.0.0.1",
      })
    ).rejects.toEqual(expectAuthError("rate_limited"));
    const bucket = await database.authRateLimitBucket.findFirstOrThrow({
      where: { requestCount: 2 },
    });
    expect(bucket.identifierHash).not.toContain("limited@example.test");
  });

  test("restricts impersonation to platform operators, exposes state, and makes audit immutable", async () => {
    const actor = await database.user.create({
      data: { email: "operator@example.test", platformOperator: true },
    });
    const target = await database.user.create({ data: { email: "target@example.test" } });
    const nonOperator = await database.user.create({ data: { email: "member@example.test" } });
    const organization = await database.organization.create({
      data: { slug: "impersonation", name: "Impersonation" },
    });
    const targetMembership = await database.organizationMembership.create({
      data: { organizationId: organization.id, userId: target.id },
    });

    const deniedSession = await auth.issueOperatorSession({ userId: nonOperator.id });
    await expect(
      auth.startImpersonation({ sessionToken: deniedSession.token, targetUserId: target.id })
    ).rejects.toEqual(expectAuthError("impersonation_forbidden"));

    const actorExpiresAt = new Date(now.getTime() + 60_000);
    const actorSession = await auth.issueOperatorSession({
      userId: actor.id,
      expiresAt: actorExpiresAt,
    });
    const impersonation = await auth.startImpersonation({
      sessionToken: actorSession.token,
      targetUserId: target.id,
      ipAddress: "127.0.0.1",
    });
    await expect(
      auth.authorizeOperatorSession(impersonation.token, organization.id)
    ).resolves.toMatchObject({
      actorUserId: actor.id,
      effectiveUserId: target.id,
      impersonation: { active: true, actorUserId: actor.id, targetUserId: target.id },
    });

    const audit = await database.impersonationAudit.findFirstOrThrow({
      where: { action: ImpersonationAction.START, actorUserId: actor.id, targetUserId: target.id },
    });
    await expect(
      database.impersonationAudit.update({
        where: { id: audit.id },
        data: { ipAddress: "tampered" },
      })
    ).rejects.toThrow(/immutable/);
    await expect(database.impersonationAudit.delete({ where: { id: audit.id } })).rejects.toThrow(
      /immutable/
    );

    const restored = await auth.stopImpersonation({ sessionToken: impersonation.token });
    expect(restored.expiresAt).toEqual(actorExpiresAt);
    await expect(auth.authorizeOperatorSession(restored.token)).resolves.toMatchObject({
      actorUserId: actor.id,
      effectiveUserId: actor.id,
      impersonation: null,
    });
    await expect(auth.authorizeOperatorSession(impersonation.token)).rejects.toEqual(
      expectAuthError("revoked")
    );
    await auth.revokeOperatorSession(actorSession.token);
    await expect(auth.authorizeOperatorSession(restored.token)).rejects.toEqual(
      expectAuthError("revoked")
    );

    const parent = await auth.issueOperatorSession({ userId: actor.id });
    const child = await auth.startImpersonation({
      sessionToken: parent.token,
      targetUserId: target.id,
    });
    await auth.revokeOperatorSession(parent.token);
    await expect(auth.authorizeOperatorSession(child.token)).rejects.toEqual(
      expectAuthError("revoked")
    );

    const nextActorSession = await auth.issueOperatorSession({ userId: actor.id });
    const affectedImpersonation = await auth.startImpersonation({
      sessionToken: nextActorSession.token,
      targetUserId: target.id,
    });
    await database.organizationMembership.update({
      where: { id: targetMembership.id },
      data: { role: OrganizationRole.ADMIN },
    });
    await expect(auth.authorizeOperatorSession(affectedImpersonation.token)).rejects.toEqual(
      expectAuthError("revoked")
    );

    await expect(database.$executeRawUnsafe('TRUNCATE TABLE "ImpersonationAudit"')).rejects.toThrow(
      /immutable/
    );
  });

  test("uses typed auth errors", () => {
    expect(new PlatosAuthError("unauthorized", 401, "no")).toMatchObject({
      name: "PlatosAuthError",
      status: 401,
    });
  });
});
