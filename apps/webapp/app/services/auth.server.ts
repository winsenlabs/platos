import { createCookie, redirect } from "@remix-run/node";
import {
  PlatosAuthError,
  PlatosAuthService,
  authorizeEnvironmentOperator,
  type EnvironmentAuthorizationAccess,
  type OperatorAuthorization,
} from "@platos/tenancy-database";
import { env } from "~/env.server";
import { database } from "./database.server";

export const operatorAuth = new PlatosAuthService(database, { encryptionKey: env.ENCRYPTION_KEY });
export const OPERATOR_SESSION_COOKIE_NAME =
  env.NODE_ENV === "production" ? "__Host-platos_operator_session" : "platos_operator_session";

const cookie = createCookie(OPERATOR_SESSION_COOKIE_NAME, {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

export type DashboardOperator = {
  authorization: OperatorAuthorization;
  userId: string;
  actorUserId: string;
  email: string;
};

export async function readOperatorToken(request: Request): Promise<string | null> {
  const value = await cookie.parse(request.headers.get("Cookie"));
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function commitOperatorSession(token: string, expiresAt: Date) {
  return cookie.serialize(token, { expires: expiresAt });
}

export function clearOperatorSession() {
  return cookie.serialize("", { expires: new Date(0), maxAge: 0 });
}

export async function optionalOperator(request: Request): Promise<DashboardOperator | null> {
  const token = await readOperatorToken(request);
  if (!token) return null;
  try {
    const authorization = await operatorAuth.authorizeOperatorSession(token);
    return {
      authorization,
      userId: authorization.effectiveUserId,
      actorUserId: authorization.actorUserId,
      email: authorization.email,
    };
  } catch {
    return null;
  }
}

export async function requireOperator(request: Request): Promise<DashboardOperator> {
  const operator = await optionalOperator(request);
  if (operator) return operator;
  const url = new URL(request.url);
  throw redirect(`/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`);
}

export async function requireEnvironmentScope(params: {
  request: Request;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  access?: EnvironmentAuthorizationAccess;
}) {
  const operator = await requireOperator(params.request);
  const environment = await database.environment.findFirst({
    where: {
      slug: params.environmentSlug,
      archivedAt: null,
      project: {
        slug: params.projectSlug,
        archivedAt: null,
        organization: { slug: params.organizationSlug, archivedAt: null },
      },
    },
    select: {
      id: true,
      slug: true,
      name: true,
      project: {
        select: {
          id: true,
          slug: true,
          name: true,
          organization: { select: { id: true, slug: true, name: true } },
        },
      },
    },
  });
  if (!environment) throw new Response("Environment not found", { status: 404 });
  const authorization = await authorizeEnvironmentOperator(
    database,
    operator.authorization,
    environment.id,
    params.access ?? "metadata"
  );
  return {
    authorization,
    operator,
    scope: {
      organizationId: authorization.organizationId,
      projectId: authorization.projectId,
      environmentId: authorization.environmentId,
      userId: authorization.effectiveUserId,
    },
    workspace: {
      organization: environment.project.organization,
      project: { id: environment.project.id, slug: environment.project.slug, name: environment.project.name },
      environment: { id: environment.id, slug: environment.slug, name: environment.name, type: environment.slug },
      operator: { id: operator.userId, email: operator.email },
    },
  };
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof PlatosAuthError) return new Response(error.message, { status: error.status });
  throw error;
}
