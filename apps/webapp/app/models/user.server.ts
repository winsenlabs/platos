import type { Prisma, User } from "@platos/database";
import { prisma } from "~/db.server";
import {
  type DashboardPreferences,
  getDashboardPreferences,
} from "~/services/dashboardPreferences.server";
import { assertEmailAllowed } from "~/utils/email";

export type { User } from "@platos/database";

export type UserWithDashboardPreferences = User & {
  dashboardPreferences: DashboardPreferences;
};

export async function getUserById(id: User["id"]): Promise<UserWithDashboardPreferences | null> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return null;
  return {
    ...user,
    dashboardPreferences: getDashboardPreferences(user.dashboardPreferences),
  };
}

export async function getUserByEmail(email: User["email"]) {
  return prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
}

export async function updateUser({
  id,
  displayName,
  email,
}: Pick<User, "id" | "displayName" | "email">) {
  assertEmailAllowed(email);
  return prisma.user.update({
    where: { id },
    data: {
      displayName: displayName?.trim() || null,
      email: email.trim().toLowerCase(),
    },
  });
}

export async function updateDashboardPreferences(
  id: User["id"],
  dashboardPreferences: Prisma.InputJsonValue
) {
  return prisma.user.update({
    where: { id },
    data: { dashboardPreferences },
  });
}
