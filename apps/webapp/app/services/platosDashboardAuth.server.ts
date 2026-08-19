import { createCookie, redirect } from "@remix-run/node";
import {
  PlatosAuthError,
  PlatosAuthService,
  authorizeEnvironmentOperator,
  type EnvironmentAuthorizationAccess,
  type EnvironmentOperatorAuthorization,
  type OperatorAuthorization,
} from "@platos/tenancy-database";
import { Prisma as LegacyPrisma } from "@platos/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { getImpersonationId } from "./impersonation.server";
import { platosControlDatabase } from "./platosControlDatabase.server";
export {
  authEmailRateLimitIdentifier,
  authSessionRateLimitIdentifier,
} from "./dashboardAuthRateLimit.server";
import {
  applyLegacyImpersonation,
  canonicalUserId,
  legacyUserId,
  normalizeBridgeEmail,
  resolveDashboardIdentity,
  type CanonicalUserId,
  type DashboardIdentity,
  type LegacyUserId,
} from "./dashboardIdentity.server";

export const platosDashboardAuth = new PlatosAuthService(platosControlDatabase, {
  encryptionKey: env.ENCRYPTION_KEY,
});

export const OPERATOR_SESSION_COOKIE_NAME =
  env.NODE_ENV === "production" ? "__Host-platos_operator_session" : "platos_operator_session";

const operatorSessionCookie = createCookie(OPERATOR_SESSION_COOKIE_NAME, {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

export async function getOperatorSessionToken(request: Request): Promise<string | null> {
  const value = await operatorSessionCookie.parse(request.headers.get("Cookie"));
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function commitOperatorSession(token: string, expiresAt: Date): Promise<string> {
  return operatorSessionCookie.serialize(token, { expires: expiresAt });
}

export function clearOperatorSession(): Promise<string> {
  return operatorSessionCookie.serialize("", { expires: new Date(0), maxAge: 0 });
}

export async function getDashboardIdentity(request: Request): Promise<DashboardIdentity | null> {
  const identity = await resolveDashboardIdentity({
    token: await getOperatorSessionToken(request),
    authorizer: platosDashboardAuth,
    legacyIdentityReader: {
      async findByNormalizedEmail(normalizedEmail) {
        return prisma.$queryRaw<Array<{ id: string; email: string }>>(LegacyPrisma.sql`
          SELECT "id", "email"
          FROM "User"
          WHERE LOWER(BTRIM("email")) = ${normalizedEmail}
          ORDER BY "id"
          LIMIT 2
        `);
      },
    },
    canonicalMfaReader: {
      async findEnabledAt(userId) {
        const credential = await platosControlDatabase.operatorMfaTotp.findUnique({
          where: { userId },
          select: { enabledAt: true },
        });
        return credential?.enabledAt ?? null;
      },
    },
    canonicalIdentityReader: {
      async findEmail(userId) {
        return canonicalEmailForUser(userId);
      },
    },
  });
  if (!identity) return null;

  const legacyTargetUserId = await getImpersonationId(request);
  if (!legacyTargetUserId || identity.authorization.impersonation) return identity;

  const [legacyActor, legacyTarget] = await Promise.all([
    prisma.user.findUnique({
      where: { id: identity.legacyActorUserId },
      select: { admin: true },
    }),
    prisma.user.findUnique({
      where: { id: legacyTargetUserId },
      select: { id: true },
    }),
  ]);
  return applyLegacyImpersonation({
    identity,
    legacyTargetUserId,
    legacyActorIsAdmin: legacyActor?.admin === true,
    legacyTargetExists: legacyTarget !== null,
  });
}

export async function requireDashboardIdentity(
  request: Request,
  redirectTo?: string
): Promise<DashboardIdentity> {
  const identity = await getDashboardIdentity(request);
  if (identity) return identity;

  const url = new URL(request.url);
  const search = new URLSearchParams([
    ["redirectTo", redirectTo ?? `${url.pathname}${url.search}`],
  ]);
  throw redirect(`/login?${search}`);
}

export async function bridgeVerifiedEmailToLegacyUser(email: string): Promise<{
  canonicalEmail: string;
  legacyUserId: LegacyUserId;
} | null> {
  const canonicalEmail = normalizeBridgeEmail(email);
  const matches = await prisma.$queryRaw<Array<{ id: string }>>(LegacyPrisma.sql`
    SELECT "id"
    FROM "User"
    WHERE LOWER(BTRIM("email")) = ${canonicalEmail}
    ORDER BY "id"
    LIMIT 2
  `);
  if (matches.length !== 1) return null;
  return { canonicalEmail, legacyUserId: legacyUserId(matches[0].id) };
}

export async function canonicalEmailForUser(userId: CanonicalUserId): Promise<string | null> {
  const user = await platosControlDatabase.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return user?.email ?? null;
}

export async function requireCanonicalAuthorization(request: Request): Promise<{
  token: string;
  authorization: OperatorAuthorization;
  canonicalActorUserId: CanonicalUserId;
  canonicalEffectiveUserId: CanonicalUserId;
  canonicalUserId: CanonicalUserId;
}> {
  const token = await getOperatorSessionToken(request);
  if (!token) throw new PlatosAuthError("unauthorized", 401, "Invalid operator session");
  const authorization = await platosDashboardAuth.authorizeOperatorSession(token);
  return {
    token,
    authorization,
    canonicalActorUserId: canonicalUserId(authorization.actorUserId),
    canonicalEffectiveUserId: canonicalUserId(authorization.effectiveUserId),
    canonicalUserId: canonicalUserId(authorization.effectiveUserId),
  };
}

export async function requireCanonicalEnvironmentAuthorization(params: {
  request: Request;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  access: EnvironmentAuthorizationAccess;
}): Promise<{
  authorization: EnvironmentOperatorAuthorization;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: CanonicalUserId;
  };
}> {
  const operator = await requireCanonicalAuthorization(params.request);
  const environment = await platosControlDatabase.environment.findFirst({
    where: {
      slug: params.environmentSlug,
      project: {
        slug: params.projectSlug,
        organization: { slug: params.organizationSlug },
      },
    },
    select: {
      id: true,
      projectId: true,
      project: { select: { organizationId: true } },
    },
  });
  if (!environment) {
    throw new PlatosAuthError("forbidden", 403, "Operator is not authorized for this environment");
  }

  const authorization = await authorizeEnvironmentOperator(
    platosControlDatabase,
    operator.authorization,
    environment.id,
    params.access
  );
  return {
    authorization,
    scope: {
      organizationId: authorization.organizationId,
      projectId: authorization.projectId,
      environmentId: authorization.environmentId,
      userId: operator.canonicalUserId,
    },
  };
}

export function isMfaRequired(error: unknown): boolean {
  return error instanceof PlatosAuthError && error.code === "mfa_required";
}
