import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { updateCurrentProjectEnvironmentId } from "~/services/dashboardPreferences.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const environment = await prisma.environment.findFirst({
    where: {
      id: envParam,
      archivedAt: null,
      project: {
        slug: projectParam,
        archivedAt: null,
        organization: {
          slug: organizationSlug,
          archivedAt: null,
          memberships: { some: { userId: user.id, deactivatedAt: null } },
        },
      },
    },
    include: { project: true },
  });
  if (!environment) {
    throw new Response("Environment not found in this scope", {
      status: 404,
      statusText: "Environment not found",
    });
  }
  await updateCurrentProjectEnvironmentId({
    user,
    projectId: environment.projectId,
    environmentId: environment.id,
  });
  return { projectId: environment.projectId, environmentId: environment.id };
};

export default function Page() {
  return <Outlet />;
}
