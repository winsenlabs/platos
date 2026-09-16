// OPERATOR IDENTITY AND ENVIRONMENT SCOPE, AFTER THE CUTOVER (WIN-257 T8).
//
// This module used to CONSTRUCT the authority it enforced: `new PlatosAuthService
// (database, …)` over the webapp's own `PrismaClient`, a `database.environment.
// findFirst` with the archived filters spelled out here, and
// `authorizeEnvironmentOperator` reaching the same client again. Six
// `operatorAuth` calls and one Prisma read lived in this file and its callers,
// which is why `tests/differential-harness/oracle-transcripts.mjs` lists it first
// among the oracle sources.
//
// Every one of them is now a named V1 operation in `coreApi.server.ts`. What is
// left here is a BFF's job and only that: read the browser's cookie, ask core-api
// who it is, and turn a refusal into the response this dashboard already
// answered with.
//
// ---------------------------------------------------------------------------
// THE COOKIE IS STILL WRITTEN HERE, AND THAT IS NOT A HALF-MEASURE
//
// core-api renders its own `Set-Cookie`, and `bff/session.controller.ts` is
// emphatic that the shape is the CONTRACT'S: the `__Host-` prefix, `Secure`,
// `HttpOnly`, `SameSite`, `Path` and the lifetime all come off a directive
// identity-access minted. It decides `Secure` and the name from ONE fact —
// `isSecureTransport(request)`, which reads `req.secure` and trusts no header.
//
// And `req.secure` there is the connection THIS PROCESS opened to core-api: a
// plain-HTTP hop across the compose network. So a webapp that relayed core-api's
// `Set-Cookie` byte for byte would hand a browser on HTTPS a cookie named
// `platos_operator_session` with no `Secure` — a silent downgrade of the
// production session credential, performed by the cutover, on every sign-in.
//
// So the VALUE travels and the SHAPE does not. `magic.tsx` reads core-api's
// `Set-Cookie` with the webapp's OWN `createCookie` parser — which works because
// D19 made core-api write the Remix dialect, `base64(JSON.stringify(token))`
// (`transports/rest/session-cookie-value.ts`) — and hands the token to
// `commitOperatorSession`, which re-serializes it under the shape this process
// derives from its own `NODE_ENV`, exactly as before. The bytes a browser
// receives at a sign-in are unchanged by this cutover, and the same token now
// authenticates through core-api, which is D19 working in both directions.
//
// When D-COOKIE lands its trusted-proxy hop and core-api can be told what the
// browser's transport really is, this becomes a relay and these three functions
// go. Until then, relaying would be wrong.

import { createCookie, redirect } from "@remix-run/node";

import { env } from "~/env.server";
import {
  CoreApiError,
  CoreApiUnavailableError,
  coreData,
  isUnauthenticated,
  type CoreEnvironmentScope,
  type CoreOperatorSession,
} from "./coreApi.server";

export const OPERATOR_SESSION_COOKIE_NAME =
  env.NODE_ENV === "production" ? "__Host-platos_operator_session" : "platos_operator_session";

const cookie = createCookie(OPERATOR_SESSION_COOKIE_NAME, {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

/** The access levels `GET /environments/by-slugs` accepts. */
export type EnvironmentAuthorizationAccess = "metadata" | "secret:mutate";

export type DashboardOperator = {
  /** The V1 session resource, exactly as core-api published it. */
  session: CoreOperatorSession;
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

/**
 * The token inside a `Set-Cookie` header core-api wrote, or null.
 *
 * Parsed by the WEBAPP'S OWN cookie, not by a second reading of the encoding.
 * `createCookie(name).parse` is the exact function every authenticated loader in
 * this tree already runs against the browser's header, so if core-api ever stops
 * writing a value this process can read, the sign-in fails here — in one place,
 * at the moment the session is minted — rather than silently on the next request.
 */
export async function operatorTokenFromSetCookie(header: string | null): Promise<string | null> {
  if (header === null || header === "") return null;
  const value = await cookie.parse(header.split(";")[0] ?? "");
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Who this browser is, or null.
 *
 * ONE 401 IS NOT AN ERROR AND EVERYTHING ELSE IS. The previous implementation
 * caught everything and answered null, which read the same way for "no session"
 * and "the store is down" — and a dashboard that redirects an operator to /login
 * because PostgreSQL blinked sends them to sign in again, where they would be
 * told the same thing. Only an `unauthenticated` refusal means "not signed in";
 * anything else is raised so `requireOperator` can answer 503.
 */
export async function optionalOperator(request: Request): Promise<DashboardOperator | null> {
  let session: CoreOperatorSession;
  try {
    session = await coreData<CoreOperatorSession>("identity.session", { request });
  } catch (error) {
    if (isUnauthenticated(error)) return null;
    throw error;
  }
  return {
    session,
    userId: session.effectiveUserId,
    actorUserId: session.actorUserId,
    email: session.email,
  };
}

export async function requireOperator(request: Request): Promise<DashboardOperator> {
  let operator: DashboardOperator | null;
  try {
    operator = await optionalOperator(request);
  } catch (error) {
    throw authErrorResponse(error);
  }
  if (operator) return operator;
  const url = new URL(request.url);
  throw redirect(`/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`);
}

/**
 * Resolve organization/project/environment SLUGS to a scope this operator holds.
 *
 * ONE CALL, NOT THREE. The old body authenticated the session, ran its own
 * `environment.findFirst` over three levels of archived filters, and then asked
 * `authorizeEnvironmentOperator` for the grant — three decisions in this process,
 * two of them duplicating filters the tenancy context also holds. `GET
 * /environments/by-slugs` is `resolveOperatorEnvironment`, which makes all three
 * at once and answers with the nodes, the sibling environments and the roles.
 *
 * SO THE 404 AND THE 403 ARE STILL DISTINCT, AND STILL THE SAME ONES. A slug
 * triple that resolves to nothing is `404 Environment not found`, the message
 * this function answered before; a resolvable environment this operator may not
 * reach at the requested access level keeps the status the context chose.
 */
export async function requireEnvironmentScope(params: {
  request: Request;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  access?: EnvironmentAuthorizationAccess;
}) {
  const operator = await requireOperator(params.request);
  let resolved: CoreEnvironmentScope;
  try {
    resolved = await coreData<CoreEnvironmentScope>("environments.bySlugs", {
      request: params.request,
      query: {
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        environmentSlug: params.environmentSlug,
        access: params.access ?? "metadata",
      },
    });
  } catch (error) {
    throw authErrorResponse(error);
  }
  return {
    authorization: {
      organizationId: resolved.organization.id,
      projectId: resolved.project.id,
      environmentId: resolved.environment.id,
      effectiveUserId: operator.userId,
      access: resolved.access,
      organizationRole: resolved.organizationRole,
      projectRole: resolved.projectRole,
    },
    operator,
    scope: {
      organizationId: resolved.organization.id,
      projectId: resolved.project.id,
      environmentId: resolved.environment.id,
      userId: operator.userId,
    },
    workspace: {
      organization: resolved.organization,
      project: resolved.project,
      environment: { ...resolved.environment, type: resolved.environment.slug },
      environments: resolved.environments,
      operator: { id: operator.userId, email: operator.email },
    },
  };
}

/**
 * A core-api refusal as the response this dashboard answers with.
 *
 * NOTHING FROM THE UPSTREAM BODY REACHES THE BROWSER. A V1 error envelope
 * carries an `errorId` and a `traceRef` for an operator to chase in the CORE
 * process's logs; reflecting it into a page would publish another deployable's
 * internals to whoever asked, and would make the 404 that hides a foreign
 * environment distinguishable from the 404 that means the slug is wrong. Every
 * message below is one this module already answered.
 *
 * A REFUSAL THAT IS NOT MINE TRAVELS. The old body re-threw anything that was
 * not a `PlatosAuthError`, and that is kept: a `Response` thrown by
 * `requireOperator` (the /login redirect) must reach Remix, not be swallowed
 * into a 503.
 */
export function authErrorResponse(error: unknown): Response {
  if (error instanceof Response) return error;
  if (error instanceof CoreApiUnavailableError) {
    return new Response("Environment not available", { status: 503 });
  }
  if (error instanceof CoreApiError) {
    if (error.status === 404) return new Response("Environment not found", { status: 404 });
    const status = error.status >= 400 && error.status <= 599 ? error.status : 503;
    return new Response(
      status === 401 ? "Not authenticated" : status === 403 ? "Forbidden" : "Environment not available",
      { status },
    );
  }
  throw error;
}
