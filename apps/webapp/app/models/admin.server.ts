import { redirect } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import type { SearchParams } from "~/routes/admin._index";
import { startImpersonation, stopImpersonation } from "~/services/impersonation.server";
import { requireUser } from "~/services/session.server";

const pageSize = 20;

async function requirePlatformOperator(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.platformOperator) throw new Response("Unauthorized", { status: 403 });
}

export async function adminGetUsers(userId: string, { page = 1, search }: SearchParams) {
  await requirePlatformOperator(userId);
  const decodedSearch = search ? decodeURIComponent(search) : undefined;
  const where = decodedSearch
    ? {
        OR: [
          { displayName: { contains: decodedSearch, mode: "insensitive" as const } },
          { email: { contains: decodedSearch, mode: "insensitive" as const } },
          {
            organizationMemberships: {
              some: {
                organization: {
                  OR: [
                    { name: { contains: decodedSearch, mode: "insensitive" as const } },
                    { slug: { contains: decodedSearch, mode: "insensitive" as const } },
                  ],
                },
              },
            },
          },
        ],
      }
    : undefined;
  const [users, totalUsers] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        email: true,
        platformOperator: true,
        createdAt: true,
        displayName: true,
        organizationMemberships: {
          where: { deactivatedAt: null },
          select: {
            organization: { select: { name: true, slug: true, archivedAt: true } },
          },
        },
      },
      where,
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.user.count({ where }),
  ]);
  return {
    users,
    page,
    pageCount: Math.ceil(totalUsers / pageSize),
    filters: { search: decodedSearch },
  };
}

export async function adminGetOrganizations(userId: string, { page = 1, search }: SearchParams) {
  await requirePlatformOperator(userId);
  const decodedSearch = search ? decodeURIComponent(search) : undefined;
  const where = decodedSearch
    ? {
        OR: [
          { name: { contains: decodedSearch, mode: "insensitive" as const } },
          { slug: { contains: decodedSearch, mode: "insensitive" as const } },
          {
            memberships: {
              some: { user: { email: { contains: decodedSearch, mode: "insensitive" as const } } },
            },
          },
        ],
      }
    : undefined;
  const [organizations, totalOrgs] = await Promise.all([
    prisma.organization.findMany({
      select: {
        id: true,
        slug: true,
        name: true,
        archivedAt: true,
        memberships: {
          where: { deactivatedAt: null },
          select: { user: { select: { email: true } } },
        },
      },
      where,
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.organization.count({ where }),
  ]);
  return {
    organizations,
    page,
    pageCount: Math.ceil(totalOrgs / pageSize),
    filters: { search: decodedSearch },
  };
}

export async function redirectWithImpersonation(request: Request, userId: string, path: string) {
  const user = await requireUser(request);
  if (!user.platformOperator) throw new Response("Unauthorized", { status: 403 });
  const cookie = await startImpersonation(userId, request);
  return redirect(path, { headers: { "Set-Cookie": cookie } });
}

export async function clearImpersonation(request: Request, path: string) {
  const cookie = await stopImpersonation(request);
  return redirect(path, { headers: { "Set-Cookie": cookie } });
}
