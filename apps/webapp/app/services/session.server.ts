import { redirect } from "@remix-run/node";
import type { OperatorAuthorization } from "@platos/database";
import { getUserById } from "~/models/user.server";
import { authorizeRequest, isSessionResetError, platosAuth } from "./platosAuth.server";
import {
  appendSessionResetCookies,
  destroyOperatorSession,
  getOperatorSessionToken,
} from "./sessionStorage.server";

export async function getOperatorAuthorization(
  request: Request,
  organizationId?: string
): Promise<(OperatorAuthorization & { token: string }) | null> {
  try {
    return await authorizeRequest(request, organizationId);
  } catch (error) {
    if (isSessionResetError(error)) return null;
    throw error;
  }
}

export async function getUserId(request: Request): Promise<string | undefined> {
  return (await getOperatorAuthorization(request))?.effectiveUserId;
}

export async function getUser(request: Request) {
  const authorization = await getOperatorAuthorization(request);
  if (!authorization) return null;
  return getUserById(authorization.effectiveUserId);
}

export async function requireUserId(request: Request, redirectTo?: string) {
  const authorization = await requireOperatorAuthorization(request, undefined, redirectTo);
  return authorization.effectiveUserId;
}

export type UserFromSession = Awaited<ReturnType<typeof requireUser>>;

export async function requireOperatorAuthorization(
  request: Request,
  organizationId?: string,
  redirectTo?: string
): Promise<OperatorAuthorization & { token: string }> {
  try {
    return await authorizeRequest(request, organizationId);
  } catch (error) {
    if (!isSessionResetError(error)) throw error;
    const url = new URL(request.url);
    const destination = redirectTo ?? `${url.pathname}${url.search}`;
    const headers = new Headers();
    await appendSessionResetCookies(headers);
    throw redirect(`/login?sessionReset=1&redirectTo=${encodeURIComponent(destination)}`, { headers });
  }
}

export async function requireUser(request: Request) {
  const authorization = await requireOperatorAuthorization(request);
  const user = await getUserById(authorization.effectiveUserId);
  if (!user) throw await logout(request);

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    platformOperator: user.platformOperator,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    dashboardPreferences: user.dashboardPreferences,
    isImpersonating: authorization.impersonation !== null,
  };
}

export async function logout(request: Request) {
  const token = await getOperatorSessionToken(request);
  if (token) await platosAuth.revokeOperatorSession(token);
  const headers = new Headers();
  await appendSessionResetCookies(headers);
  return redirect("/login", { headers });
}
