import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { requireUser } from "~/services/session.server";
import { ProjectParamSchema, v3EnvironmentPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);
  const project = await prisma.project.findFirst({
    where: {
      slug: projectParam,
      archivedAt: null,
      organization: {
        slug: organizationSlug,
        archivedAt: null,
        memberships: { some: { userId: user.id, deactivatedAt: null } },
      },
    },
    include: {
      organization: true,
      environments: {
        where: { archivedAt: null },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!project) throw new Response("Project not found", { status: 404 });
  const preferredEnvironmentId =
    user.dashboardPreferences.projects[project.id]?.currentEnvironment.id;
  const environment =
    project.environments.find((item) => item.id === preferredEnvironmentId) ??
    project.environments[0];
  if (!environment) {
    throw new Response("This project has no active environments", {
      status: 404,
      statusText: "Environment unavailable",
    });
  }
  return redirect(v3EnvironmentPath(project.organization, project, environment));
};
