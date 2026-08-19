import { redirect } from "@remix-run/node";
import { getUserById } from "~/models/user.server";
import {
  getDashboardIdentity,
  requireDashboardIdentity,
} from "./platosDashboardAuth.server";
import type { LegacyUserId } from "./dashboardIdentity.server";

export async function getUserId(request: Request): Promise<LegacyUserId | undefined> {
  return (await getDashboardIdentity(request))?.legacyEffectiveUserId;
}

export async function getUser(request: Request) {
  const userId = await getUserId(request);
  if (userId === undefined) return null;

  const user = await getUserById(userId);
  if (user) return user;

  throw await logout(request);
}

export async function requireUserId(request: Request, redirectTo?: string) {
  return (await requireDashboardIdentity(request, redirectTo)).legacyEffectiveUserId;
}

export type UserFromSession = Awaited<ReturnType<typeof requireUser>>;

export async function requireUser(request: Request) {
  const identity = await requireDashboardIdentity(request);
  const userId = identity.legacyEffectiveUserId;
  const user = await getUserById(userId);
  if (user) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      admin: user.admin,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      dashboardPreferences: user.dashboardPreferences,
      confirmedBasicDetails: user.confirmedBasicDetails,
      mfaEnabledAt: identity.mfaEnabledAt,
      isImpersonating: identity.isImpersonating,
    };
  }

  throw await logout(request);
}

export async function logout(request: Request) {
  return redirect("/logout");
}
