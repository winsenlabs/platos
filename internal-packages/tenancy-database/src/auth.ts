import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  AuthRateLimitAction,
  ImpersonationAction,
  OperatorIdentityProvider,
  OrganizationRole,
  PrincipalTier,
  Prisma,
  ProjectRole,
  type PrismaClient,
} from "../generated/control";

const SESSION_PREFIX = "plt_os_";
const MAGIC_LINK_PREFIX = "plt_ml_";
const INVITATION_PREFIX = "plt_inv_";
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MFA_ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const RECOVERY_CODE_COUNT = 9;

type DatabaseClient = PrismaClient | Prisma.TransactionClient;
type Clock = () => Date;
type TokenGenerator = (prefix: string) => string;

export type AuthErrorCode =
  | "unauthorized"
  | "forbidden"
  | "expired"
  | "revoked"
  | "mfa_required"
  | "invalid_mfa"
  | "rate_limited"
  | "invite_invalid"
  | "invite_email_mismatch"
  | "invite_consumed"
  | "owner_invariant"
  | "impersonation_forbidden";

export class PlatosAuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    public readonly status: 401 | 403 | 409 | 429,
    message: string,
    public readonly retryAt?: Date
  ) {
    super(message);
    this.name = "PlatosAuthError";
  }
}

export interface PlatosAuthServiceOptions {
  encryptionKey: string | Buffer;
  now?: Clock;
  tokenGenerator?: TokenGenerator;
  sessionTtlMs?: number;
  loginRateLimit?: { attempts: number; windowMs: number };
  inviteAcceptRateLimit?: { attempts: number; windowMs: number };
  mfaVerifyRateLimit?: { attempts: number; windowMs: number };
}

export interface OperatorAuthorization {
  sessionId: string;
  actorUserId: string;
  effectiveUserId: string;
  email: string;
  role?: OrganizationRole;
  expiresAt: Date;
  mfaVerifiedAt: Date | null;
  impersonation: null | {
    active: true;
    actorUserId: string;
    targetUserId: string;
  };
}

const environmentAuthorizationBrand: unique symbol = Symbol("EnvironmentAuthorization");

export type EnvironmentAuthorizationAccess = "metadata" | "secret:mutate";

export interface EnvironmentOperatorAuthorization {
  readonly [environmentAuthorizationBrand]: true;
  readonly principalType: "operator";
  readonly tier: "OPERATOR";
  readonly access: EnvironmentAuthorizationAccess;
  readonly environmentId: string;
  readonly projectId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly effectiveUserId: string;
  readonly organizationRole: OrganizationRole;
  readonly projectRole: ProjectRole | null;
}

export interface AuthenticatedRuntimeActor {
  readonly actorId: string;
  readonly environmentId: string;
}

export interface EnvironmentRuntimeAuthorization {
  readonly [environmentAuthorizationBrand]: true;
  readonly principalType: "runtime";
  readonly tier: "RUNTIME";
  readonly access: "secret:read";
  readonly environmentId: string;
  readonly projectId: string;
  readonly organizationId: string;
  readonly actorId: string;
}

export interface EnvironmentServiceAuthorization {
  readonly [environmentAuthorizationBrand]: true;
  readonly principalType: "service";
  readonly tier: "RUNTIME";
  readonly access: "secret:write";
  readonly environmentId: string;
  readonly projectId: string;
  readonly organizationId: string;
  readonly actorId: string;
}

export type EnvironmentAuthorization =
  | EnvironmentOperatorAuthorization
  | EnvironmentRuntimeAuthorization
  | EnvironmentServiceAuthorization;

/**
 * Resolves Environment ancestry and current memberships from canonical rows.
 * Callers pass the result of operator-session authentication, never tenant IDs
 * copied from request headers.
 */
export async function authorizeEnvironmentOperator(
  database: DatabaseClient,
  operator: OperatorAuthorization,
  environmentId: string,
  access: EnvironmentAuthorizationAccess
): Promise<EnvironmentOperatorAuthorization> {
  const environment = await database.environment.findUnique({
    where: { id: environmentId },
    select: {
      id: true,
      archivedAt: true,
      project: {
        select: { id: true, archivedAt: true, organizationId: true, organization: { select: { archivedAt: true } } },
      },
    },
  });
  if (
    !environment ||
    environment.archivedAt ||
    environment.project.archivedAt ||
    environment.project.organization.archivedAt
  ) {
    throw environmentForbidden();
  }

  const organizationMembership = await database.organizationMembership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: environment.project.organizationId,
        userId: operator.effectiveUserId,
      },
    },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!organizationMembership || organizationMembership.deactivatedAt) {
    throw environmentForbidden();
  }

  const projectMembership = await database.projectMembership.findUnique({
    where: {
      projectId_organizationMembershipId: {
        projectId: environment.project.id,
        organizationMembershipId: organizationMembership.id,
      },
    },
    select: { role: true },
  });
  const organizationAdmin =
    organizationMembership.role === OrganizationRole.OWNER ||
    organizationMembership.role === OrganizationRole.ADMIN;
  if (!organizationAdmin && !projectMembership) throw environmentForbidden();
  if (access === "secret:mutate" && !organizationAdmin && projectMembership?.role !== ProjectRole.ADMIN) {
    throw environmentForbidden();
  }

  return Object.freeze({
    [environmentAuthorizationBrand]: true as const,
    principalType: "operator",
    tier: PrincipalTier.OPERATOR,
    access,
    environmentId: environment.id,
    projectId: environment.project.id,
    organizationId: environment.project.organizationId,
    actorUserId: operator.actorUserId,
    effectiveUserId: operator.effectiveUserId,
    organizationRole: organizationMembership.role,
    projectRole: projectMembership?.role ?? null,
  });
}

/**
 * Pins an already-authenticated runtime actor to ancestry loaded from the
 * database. End-user sessions are intentionally not accepted by this API.
 */
export async function authorizeEnvironmentRuntime(
  database: DatabaseClient,
  actor: AuthenticatedRuntimeActor
): Promise<EnvironmentRuntimeAuthorization> {
  const environment = await database.environment.findUnique({
    where: { id: actor.environmentId },
    select: {
      id: true,
      archivedAt: true,
      project: {
        select: { id: true, archivedAt: true, organizationId: true, organization: { select: { archivedAt: true } } },
      },
    },
  });
  if (
    !actor.actorId ||
    !environment ||
    environment.archivedAt ||
    environment.project.archivedAt ||
    environment.project.organization.archivedAt
  ) {
    throw environmentForbidden();
  }
  return Object.freeze({
    [environmentAuthorizationBrand]: true as const,
    principalType: "runtime",
    tier: "RUNTIME",
    access: "secret:read",
    environmentId: environment.id,
    projectId: environment.project.id,
    organizationId: environment.project.organizationId,
    actorId: actor.actorId,
  });
}

/** Resolve a trusted internal service actor for non-dashboard credential writes. */
export async function authorizeEnvironmentService(
  database: DatabaseClient,
  actor: AuthenticatedRuntimeActor
): Promise<EnvironmentServiceAuthorization> {
  const runtime = await authorizeEnvironmentRuntime(database, actor);
  return Object.freeze({
    [environmentAuthorizationBrand]: true as const,
    principalType: "service",
    tier: "RUNTIME",
    access: "secret:write",
    environmentId: runtime.environmentId,
    projectId: runtime.projectId,
    organizationId: runtime.organizationId,
    actorId: runtime.actorId,
  });
}

export interface SessionIssueResult {
  token: string;
  expiresAt: Date;
}

export class PlatosAuthService {
  readonly #database: PrismaClient;
  readonly #encryptionKey: Buffer;
  readonly #now: Clock;
  readonly #tokenGenerator: TokenGenerator;
  readonly #sessionTtlMs: number;
  readonly #loginRateLimit: { attempts: number; windowMs: number };
  readonly #inviteAcceptRateLimit: { attempts: number; windowMs: number };
  readonly #mfaVerifyRateLimit: { attempts: number; windowMs: number };

  constructor(database: PrismaClient, options: PlatosAuthServiceOptions) {
    this.#database = database;
    this.#encryptionKey = parseEncryptionKey(options.encryptionKey);
    this.#now = options.now ?? (() => new Date());
    this.#tokenGenerator = options.tokenGenerator ?? generateOpaqueToken;
    this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#loginRateLimit = options.loginRateLimit ?? { attempts: 10, windowMs: 60_000 };
    this.#inviteAcceptRateLimit = options.inviteAcceptRateLimit ?? {
      attempts: 10,
      windowMs: 15 * 60_000,
    };
    this.#mfaVerifyRateLimit = options.mfaVerifyRateLimit ?? {
      attempts: 5,
      windowMs: 5 * 60_000,
    };
  }

  async issueOperatorSession(params: {
    userId: string;
    expiresAt?: Date;
    mfaVerifiedAt?: Date | null;
  }): Promise<SessionIssueResult> {
    return this.#issueSession(this.#database, params);
  }

  async authorizeOperatorSession(
    rawToken: string | null | undefined,
    organizationId?: string
  ): Promise<OperatorAuthorization> {
    if (!rawToken) throw unauthorized();

    const now = this.#now();
    const session = await this.#database.operatorSession.findUnique({
      where: { tokenHash: hashSecret(rawToken) },
      include: {
        user: { include: { mfaTotp: true } },
        impersonatedUser: true,
        parentSession: true,
      },
    });

    if (!session || session.user.disabledAt) throw unauthorized();
    if (session.revokedAt) throw new PlatosAuthError("revoked", 401, "Session revoked");
    if (session.expiresAt.getTime() <= now.getTime()) {
      throw new PlatosAuthError("expired", 401, "Session expired");
    }
    if (session.user.mfaTotp?.enabledAt && !session.mfaVerifiedAt) {
      throw new PlatosAuthError("mfa_required", 401, "Multi-factor authentication required");
    }
    if (
      session.parentSessionId &&
      (!session.parentSession ||
        session.parentSession.userId !== session.userId ||
        session.parentSession.impersonatedUserId !== null ||
        session.parentSession.revokedAt !== null ||
        session.parentSession.expiresAt.getTime() <= now.getTime())
    ) {
      throw new PlatosAuthError("revoked", 401, "Parent session is no longer active");
    }
    if (
      session.impersonatedUserId &&
      (!session.user.platformOperator ||
        !session.impersonatedUser ||
        session.impersonatedUser.disabledAt)
    ) {
      throw unauthorized();
    }

    const effectiveUserId = session.impersonatedUserId ?? session.userId;
    let role: OrganizationRole | undefined;
    if (organizationId) {
      const membership = await this.#database.organizationMembership.findUnique({
        where: { organizationId_userId: { organizationId, userId: effectiveUserId } },
      });
      if (!membership || membership.deactivatedAt) {
        throw new PlatosAuthError(
          "forbidden",
          403,
          "Session is not authorized for this organization"
        );
      }
      role = membership.role;
    }

    await this.#database.operatorSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { lastSeenAt: now },
    });

    const effectiveUser = session.impersonatedUser ?? session.user;
    return {
      sessionId: session.id,
      actorUserId: session.userId,
      effectiveUserId,
      email: effectiveUser.email,
      role,
      expiresAt: session.expiresAt,
      mfaVerifiedAt: session.mfaVerifiedAt,
      impersonation: session.impersonatedUserId
        ? {
            active: true,
            actorUserId: session.userId,
            targetUserId: session.impersonatedUserId,
          }
        : null,
    };
  }

  async revokeOperatorSession(rawToken: string): Promise<boolean> {
    const result = await this.#database.operatorSession.updateMany({
      where: { tokenHash: hashSecret(rawToken), revokedAt: null },
      data: { revokedAt: this.#now() },
    });
    return result.count === 1;
  }

  async changeMembershipRole(params: {
    organizationId: string;
    membershipId: string;
    actorUserId: string;
    role: OrganizationRole;
  }): Promise<void> {
    const now = this.#now();
    await this.#database.$transaction(async (tx) => {
      // Serialize role changes per Organization so two concurrent owner
      // demotions cannot both observe another active owner.
      const organization = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
          FROM "public"."Organization"
         WHERE id = ${params.organizationId}::uuid
           AND "archivedAt" IS NULL
         FOR UPDATE
      `);
      if (organization.length !== 1) throw forbiddenMembershipMutation();

      const actor = await tx.organizationMembership.findFirst({
        where: {
          organizationId: params.organizationId,
          userId: params.actorUserId,
          deactivatedAt: null,
          role: { in: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
        },
        select: { role: true },
      });
      const target = await tx.organizationMembership.findFirst({
        where: {
          id: params.membershipId,
          organizationId: params.organizationId,
          deactivatedAt: null,
        },
        select: { id: true, userId: true, role: true },
      });
      if (!actor || !target) throw forbiddenMembershipMutation();
      if (
        actor.role !== OrganizationRole.OWNER &&
        (target.role === OrganizationRole.OWNER || params.role === OrganizationRole.OWNER)
      ) {
        throw forbiddenMembershipMutation();
      }
      if (target.role === params.role) return;
      if (target.role === OrganizationRole.OWNER && params.role !== OrganizationRole.OWNER) {
        const owners = await tx.organizationMembership.count({
          where: {
            organizationId: params.organizationId,
            deactivatedAt: null,
            role: OrganizationRole.OWNER,
          },
        });
        if (owners <= 1) {
          throw new PlatosAuthError(
            "owner_invariant",
            409,
            "An organization must retain at least one active owner"
          );
        }
      }

      await tx.organizationMembership.update({
        where: {
          id_organizationId: {
            id: target.id,
            organizationId: params.organizationId,
          },
        },
        data: { role: params.role },
      });
      // Revoke both direct and impersonated sessions for the affected user in
      // the same transaction as the privilege mutation. The database trigger
      // remains defense in depth for callers that bypass this service.
      await tx.operatorSession.updateMany({
        where: {
          revokedAt: null,
          OR: [{ userId: target.userId }, { impersonatedUserId: target.userId }],
        },
        data: { revokedAt: now },
      });
    });
  }

  async removeMembership(membershipId: string): Promise<void> {
    await this.#database.organizationMembership.update({
      where: { id: membershipId },
      data: { deactivatedAt: this.#now() },
    });
  }

  async issueMagicLink(params: {
    email: string;
    rateLimitIdentifier: string;
    expiresAt?: Date;
  }): Promise<{ token: string; expiresAt: Date }> {
    await this.#consumeRateLimit(
      AuthRateLimitAction.LOGIN,
      params.rateLimitIdentifier,
      this.#loginRateLimit
    );
    const email = normalizeEmail(params.email);
    const token = this.#tokenGenerator(MAGIC_LINK_PREFIX);
    const expiresAt =
      params.expiresAt ?? new Date(this.#now().getTime() + DEFAULT_MAGIC_LINK_TTL_MS);
    await this.#database.magicLinkToken.create({
      data: { email, tokenHash: hashSecret(token), expiresAt },
    });
    return { token, expiresAt };
  }

  async consumeMagicLink(token: string): Promise<SessionIssueResult & { userId: string }> {
    const now = this.#now();
    return this.#database.$transaction(async (tx) => {
      const link = await tx.magicLinkToken.findUnique({ where: { tokenHash: hashSecret(token) } });
      if (!link || link.expiresAt.getTime() <= now.getTime()) throw unauthorized();
      const consumed = await tx.magicLinkToken.updateMany({
        where: { id: link.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw unauthorized();

      const email = normalizeEmail(link.email);
      const user = await tx.user.upsert({
        where: { email },
        create: { email },
        update: {},
      });
      if (user.disabledAt) throw unauthorized();
      await tx.operatorIdentity.upsert({
        where: {
          provider_subject: { provider: OperatorIdentityProvider.MAGIC_LINK, subject: email },
        },
        create: {
          userId: user.id,
          provider: OperatorIdentityProvider.MAGIC_LINK,
          subject: email,
          providerEmail: email,
        },
        update: { providerEmail: email },
      });
      return { ...(await this.#issueSession(tx, { userId: user.id })), userId: user.id };
    });
  }

  async completeOAuthLogin(params: {
    provider: Exclude<OperatorIdentityProvider, "MAGIC_LINK">;
    subject: string;
    email: string;
    emailVerified: boolean;
    rateLimitIdentifier: string;
  }): Promise<SessionIssueResult & { userId: string }> {
    if (!params.emailVerified) throw unauthorized();
    await this.#consumeRateLimit(
      AuthRateLimitAction.LOGIN,
      params.rateLimitIdentifier,
      this.#loginRateLimit
    );
    const email = normalizeEmail(params.email);
    return this.#database.$transaction(async (tx) => {
      const existingIdentity = await tx.operatorIdentity.findUnique({
        where: { provider_subject: { provider: params.provider, subject: params.subject } },
      });
      const user = existingIdentity
        ? await tx.user.findUnique({ where: { id: existingIdentity.userId } })
        : await tx.user.upsert({ where: { email }, create: { email }, update: {} });
      if (!user || user.disabledAt) throw unauthorized();

      await tx.operatorIdentity.upsert({
        where: { provider_subject: { provider: params.provider, subject: params.subject } },
        create: {
          userId: user.id,
          provider: params.provider,
          subject: params.subject,
          providerEmail: email,
        },
        update: { providerEmail: email },
      });
      return { ...(await this.#issueSession(tx, { userId: user.id })), userId: user.id };
    });
  }

  async beginTotpEnrollment(userId: string): Promise<{ secret: string; otpAuthUrl: string }> {
    const user = await this.#database.user.findUnique({ where: { id: userId } });
    if (!user || user.disabledAt) throw unauthorized();
    const secretBytes = randomBytes(20);
    const secret = encodeBase32(secretBytes);
    const pendingEncryptedSecret = encryptSecret(secret, this.#encryptionKey);
    const pendingExpiresAt = new Date(this.#now().getTime() + DEFAULT_MFA_ENROLLMENT_TTL_MS);
    await this.#database.operatorMfaTotp.upsert({
      where: { userId },
      create: { userId, pendingEncryptedSecret, pendingExpiresAt },
      update: {
        pendingEncryptedSecret,
        pendingExpiresAt,
      },
    });
    return {
      secret,
      otpAuthUrl: `otpauth://totp/${encodeURIComponent(
        `Platos:${user.email}`
      )}?secret=${secret}&issuer=Platos&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`,
    };
  }

  async confirmTotpEnrollment(
    userId: string,
    code: string,
    rateLimitIdentifier: string
  ): Promise<{ recoveryCodes: string[] }> {
    await this.#consumeRateLimit(
      AuthRateLimitAction.MFA_VERIFY,
      `enrollment:${userId}:${rateLimitIdentifier}`,
      this.#mfaVerifyRateLimit
    );
    const now = this.#now();
    const credential = await this.#database.operatorMfaTotp.findUnique({ where: { userId } });
    if (
      !credential?.pendingEncryptedSecret ||
      !credential.pendingExpiresAt ||
      credential.pendingExpiresAt.getTime() <= now.getTime()
    ) {
      throw new PlatosAuthError("invalid_mfa", 401, "Invalid authentication code");
    }
    const pendingEncryptedSecret = credential.pendingEncryptedSecret;
    const secret = decryptSecret(pendingEncryptedSecret, this.#encryptionKey);
    const counter = verifyTotp(secret, code, now);
    if (counter === null)
      throw new PlatosAuthError("invalid_mfa", 401, "Invalid authentication code");

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      formatRecoveryCode(randomBytes(10))
    );
    await this.#database.$transaction(async (tx) => {
      const activated = await tx.operatorMfaTotp.updateMany({
        where: {
          userId,
          pendingEncryptedSecret,
          pendingExpiresAt: { gt: now },
        },
        data: {
          encryptedSecret: pendingEncryptedSecret,
          enabledAt: now,
          lastUsedCounter: counter,
          pendingEncryptedSecret: null,
          pendingExpiresAt: null,
        },
      });
      if (activated.count !== 1) {
        throw new PlatosAuthError("invalid_mfa", 401, "Invalid authentication code");
      }
      await tx.operatorMfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.operatorMfaRecoveryCode.createMany({
        data: recoveryCodes.map((recoveryCode) => ({
          userId,
          codeHash: hashSecret(normalizeRecoveryCode(recoveryCode)),
        })),
      });
      await tx.operatorSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
    });
    return { recoveryCodes };
  }

  async verifyMfaForSession(params: {
    sessionToken: string;
    rateLimitIdentifier: string;
    totpCode?: string;
    recoveryCode?: string;
  }): Promise<void> {
    const now = this.#now();
    await this.#database.$transaction(async (tx) => {
      const session = await this.#verifyMfaForActiveSession(tx, params, now);
      await tx.operatorSession.update({
        where: { id: session.id },
        data: { mfaVerifiedAt: now },
      });
    });
  }

  async disableTotpForSession(params: {
    sessionToken: string;
    rateLimitIdentifier: string;
    totpCode?: string;
    recoveryCode?: string;
  }): Promise<void> {
    const now = this.#now();
    await this.#database.$transaction(async (tx) => {
      const session = await this.#verifyMfaForActiveSession(tx, params, now);
      await tx.operatorMfaRecoveryCode.deleteMany({ where: { userId: session.userId } });
      await tx.operatorMfaTotp.delete({ where: { userId: session.userId } });
      await tx.operatorSession.updateMany({
        where: { userId: session.userId, id: { not: session.id }, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.operatorSession.update({
        where: { id: session.id },
        data: { mfaVerifiedAt: null },
      });
    });
  }

  async #verifyMfaForActiveSession(
    database: Prisma.TransactionClient,
    params: {
      sessionToken: string;
      rateLimitIdentifier: string;
      totpCode?: string;
      recoveryCode?: string;
    },
    now: Date
  ): Promise<{ id: string; userId: string }> {
    const tokenHash = hashSecret(params.sessionToken);
    const lockedSession = await database.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "OperatorSession"
      WHERE "tokenHash" = ${tokenHash}
      FOR UPDATE
    `;
    if (lockedSession.length !== 1) throw unauthorized();

    const session = await database.operatorSession.findUnique({
      where: { id: lockedSession[0].id },
      include: { user: true },
    });
    if (
      !session ||
      session.user.disabledAt ||
      session.revokedAt ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      throw unauthorized();
    }

    await database.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "OperatorMfaTotp"
      WHERE "userId" = ${session.userId}::uuid
      FOR UPDATE
    `;
    const credential = await database.operatorMfaTotp.findUnique({
      where: { userId: session.userId },
    });
    if (!credential?.enabledAt || !credential.encryptedSecret) {
      throw new PlatosAuthError("invalid_mfa", 401, "Invalid authentication code");
    }
    await this.#consumeMfaRateLimit(params.rateLimitIdentifier);

    let verified = false;
    if (params.totpCode) {
      const secret = decryptSecret(credential.encryptedSecret, this.#encryptionKey);
      const counter = verifyTotp(secret, params.totpCode, now);
      if (counter !== null) {
        const updated = await database.operatorMfaTotp.updateMany({
          where: {
            id: credential.id,
            OR: [{ lastUsedCounter: null }, { lastUsedCounter: { lt: counter } }],
          },
          data: { lastUsedCounter: counter },
        });
        verified = updated.count === 1;
      }
    } else if (params.recoveryCode) {
      const consumed = await database.operatorMfaRecoveryCode.updateMany({
        where: {
          userId: session.userId,
          codeHash: hashSecret(normalizeRecoveryCode(params.recoveryCode)),
          consumedAt: null,
        },
        data: { consumedAt: now },
      });
      verified = consumed.count === 1;
    }
    if (!verified) throw new PlatosAuthError("invalid_mfa", 401, "Invalid authentication code");

    return { id: session.id, userId: session.userId };
  }

  async #consumeMfaRateLimit(rateLimitIdentifier: string): Promise<void> {
    await this.#consumeRateLimit(
      AuthRateLimitAction.MFA_VERIFY,
      `session:${rateLimitIdentifier}`,
      this.#mfaVerifyRateLimit
    );
  }

  async issueInvitation(params: {
    organizationId: string;
    inviterId: string;
    email: string;
    role?: OrganizationRole;
    expiresAt?: Date;
  }): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
    const now = this.#now();
    const email = normalizeEmail(params.email);
    const token = this.#tokenGenerator(INVITATION_PREFIX);
    const expiresAt = params.expiresAt ?? new Date(now.getTime() + DEFAULT_INVITATION_TTL_MS);
    return this.#database.$transaction(async (tx) => {
      const lockKey = `organization-invitation:${params.organizationId}:${email}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      await tx.organizationInvitation.updateMany({
        where: {
          organizationId: params.organizationId,
          email,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      const invitation = await tx.organizationInvitation.create({
        data: {
          organizationId: params.organizationId,
          inviterId: params.inviterId,
          email,
          role: params.role ?? OrganizationRole.MEMBER,
          tokenHash: hashSecret(token),
          expiresAt,
        },
      });
      return { invitationId: invitation.id, token, expiresAt };
    });
  }

  async acceptInvitation(params: {
    token: string;
    userId: string;
    email: string;
    rateLimitIdentifier: string;
  }): Promise<{ organizationId: string; role: OrganizationRole }> {
    await this.#consumeRateLimit(
      AuthRateLimitAction.INVITE_ACCEPT,
      params.rateLimitIdentifier,
      this.#inviteAcceptRateLimit
    );
    const now = this.#now();
    const email = normalizeEmail(params.email);
    return this.#database.$transaction(async (tx) => {
      const invitation = await tx.organizationInvitation.findUnique({
        where: { tokenHash: hashSecret(params.token) },
      });
      if (!invitation || invitation.revokedAt || invitation.expiresAt.getTime() <= now.getTime()) {
        throw new PlatosAuthError("invite_invalid", 401, "Invitation is invalid or expired");
      }
      if (invitation.acceptedAt) {
        throw new PlatosAuthError("invite_consumed", 409, "Invitation has already been accepted");
      }
      if (normalizeEmail(invitation.email) !== email) {
        throw new PlatosAuthError(
          "invite_email_mismatch",
          403,
          "Invitation belongs to another email address"
        );
      }
      const user = await tx.user.findUnique({ where: { id: params.userId } });
      if (!user || normalizeEmail(user.email) !== email) {
        throw new PlatosAuthError(
          "invite_email_mismatch",
          403,
          "Invitation belongs to another email address"
        );
      }

      const consumed = await tx.organizationInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: now, acceptedByUserId: params.userId },
      });
      if (consumed.count !== 1) {
        throw new PlatosAuthError("invite_consumed", 409, "Invitation has already been accepted");
      }
      await tx.organizationMembership.upsert({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId: params.userId,
          },
        },
        create: {
          organizationId: invitation.organizationId,
          userId: params.userId,
          role: invitation.role,
        },
        update: { role: invitation.role, deactivatedAt: null },
      });
      return { organizationId: invitation.organizationId, role: invitation.role };
    });
  }

  async startImpersonation(params: {
    sessionToken: string;
    targetUserId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<SessionIssueResult> {
    const authorization = await this.authorizeOperatorSession(params.sessionToken);
    if (authorization.impersonation) throw impersonationForbidden();
    const actor = await this.#database.user.findUnique({
      where: { id: authorization.actorUserId },
    });
    const target = await this.#database.user.findUnique({ where: { id: params.targetUserId } });
    if (!actor?.platformOperator || !target || target.disabledAt) throw impersonationForbidden();

    return this.#database.$transaction(async (tx) => {
      const issued = await this.#issueSession(tx, {
        userId: actor.id,
        impersonatedUserId: target.id,
        parentSessionId: authorization.sessionId,
        mfaVerifiedAt: authorization.mfaVerifiedAt,
        expiresAt: authorization.expiresAt,
      });
      const session = await tx.operatorSession.findUniqueOrThrow({
        where: { tokenHash: hashSecret(issued.token) },
      });
      await tx.impersonationAudit.create({
        data: {
          action: ImpersonationAction.START,
          actorUserId: actor.id,
          targetUserId: target.id,
          impersonationSessionId: session.id,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
        },
      });
      return issued;
    });
  }

  async stopImpersonation(params: {
    sessionToken: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<SessionIssueResult> {
    const authorization = await this.authorizeOperatorSession(params.sessionToken);
    if (!authorization.impersonation) throw impersonationForbidden();
    const now = this.#now();
    return this.#database.$transaction(async (tx) => {
      const impersonationSession = await tx.operatorSession.findUnique({
        where: { id: authorization.sessionId },
        select: { parentSessionId: true },
      });
      if (!impersonationSession?.parentSessionId) throw impersonationForbidden();

      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "OperatorSession"
        WHERE id = ${impersonationSession.parentSessionId}::uuid
        FOR UPDATE
      `;
      const parentSession = await tx.operatorSession.findUnique({
        where: { id: impersonationSession.parentSessionId },
      });
      if (
        !parentSession ||
        parentSession.userId !== authorization.actorUserId ||
        parentSession.impersonatedUserId !== null ||
        parentSession.revokedAt !== null ||
        parentSession.expiresAt.getTime() <= now.getTime()
      ) {
        throw new PlatosAuthError("revoked", 401, "Parent session is no longer active");
      }

      await tx.operatorSession.update({
        where: { id: authorization.sessionId },
        data: { revokedAt: now },
      });
      await tx.impersonationAudit.create({
        data: {
          action: ImpersonationAction.STOP,
          actorUserId: authorization.actorUserId,
          targetUserId: authorization.effectiveUserId,
          impersonationSessionId: authorization.sessionId,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
        },
      });
      return this.#issueSession(tx, {
        userId: authorization.actorUserId,
        parentSessionId: parentSession.id,
        mfaVerifiedAt: authorization.mfaVerifiedAt,
        expiresAt: authorization.expiresAt,
      });
    });
  }

  async #issueSession(
    database: DatabaseClient,
    params: {
      userId: string;
      impersonatedUserId?: string;
      parentSessionId?: string;
      expiresAt?: Date;
      mfaVerifiedAt?: Date | null;
    }
  ): Promise<SessionIssueResult> {
    const token = this.#tokenGenerator(SESSION_PREFIX);
    const expiresAt = params.expiresAt ?? new Date(this.#now().getTime() + this.#sessionTtlMs);
    await database.operatorSession.create({
      data: {
        userId: params.userId,
        impersonatedUserId: params.impersonatedUserId,
        parentSessionId: params.parentSessionId,
        tokenHash: hashSecret(token),
        expiresAt,
        mfaVerifiedAt: params.mfaVerifiedAt,
      },
    });
    return { token, expiresAt };
  }

  async #consumeRateLimit(
    action: AuthRateLimitAction,
    identifier: string,
    limit: { attempts: number; windowMs: number }
  ): Promise<void> {
    const now = this.#now();
    const windowStartMs = Math.floor(now.getTime() / limit.windowMs) * limit.windowMs;
    const windowStart = new Date(windowStartMs);
    const expiresAt = new Date(windowStartMs + limit.windowMs);
    const identifierHash = hashSecret(identifier.trim().toLowerCase());
    const bucket = await this.#database.authRateLimitBucket.upsert({
      where: {
        action_identifierHash_windowStart: {
          action,
          identifierHash,
          windowStart,
        },
      },
      create: {
        action,
        identifierHash,
        windowStart,
        expiresAt,
      },
      update: { attempts: { increment: 1 } },
    });
    if (bucket.attempts > limit.attempts) {
      throw new PlatosAuthError("rate_limited", 429, "Too many authentication attempts", expiresAt);
    }
  }
}

export function operatorSessionCookie(token: string, secure = true): string {
  return [
    `__Host-platos_operator_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generateTotp(secret: string, at: Date = new Date()): string {
  const counter = BigInt(Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS));
  return totpAtCounter(decodeBase32(secret), counter);
}

export function encryptSecret(secret: string, keyInput: string | Buffer): string {
  const key = parseEncryptionKey(keyInput);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(payload: string, keyInput: string | Buffer): string {
  const key = parseEncryptionKey(keyInput);
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted MFA secret");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function verifyTotp(secret: string, submitted: string, now: Date): bigint | null {
  if (!/^\d{6}$/.test(submitted)) return null;
  const secretBytes = decodeBase32(secret);
  const current = BigInt(Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS));
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const counter = current + BigInt(offset);
    if (counter < 0n) continue;
    const expected = totpAtCounter(secretBytes, counter);
    if (safeEqual(submitted, expected)) return counter;
  }
  return null;
}

function totpAtCounter(secret: Buffer, counter: bigint): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function parseEncryptionKey(input: string | Buffer): Buffer {
  const key = Buffer.isBuffer(input)
    ? Buffer.from(input)
    : /^[0-9a-f]{64}$/i.test(input)
    ? Buffer.from(input, "hex")
    : Buffer.from(input, "utf8");
  if (key.length !== 32) throw new Error("Platos auth encryption key must be exactly 32 bytes");
  return key;
}

function generateOpaqueToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function formatRecoveryCode(bytes: Buffer): string {
  const value = bytes.toString("hex").toUpperCase();
  return `${value.slice(0, 5)}-${value.slice(5, 10)}-${value.slice(10, 15)}-${value.slice(15, 20)}`;
}

function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function encodeBase32(input: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of input.toUpperCase().replace(/=+$/g, "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function unauthorized(): PlatosAuthError {
  return new PlatosAuthError("unauthorized", 401, "Invalid operator session");
}

function forbiddenMembershipMutation(): PlatosAuthError {
  return new PlatosAuthError("forbidden", 403, "Membership role change is not authorized");
}

function environmentForbidden(): PlatosAuthError {
  return new PlatosAuthError(
    "forbidden",
    403,
    "Operator is not authorized for this environment"
  );
}

function impersonationForbidden(): PlatosAuthError {
  return new PlatosAuthError(
    "impersonation_forbidden",
    403,
    "Impersonation requires a platform operator session"
  );
}
