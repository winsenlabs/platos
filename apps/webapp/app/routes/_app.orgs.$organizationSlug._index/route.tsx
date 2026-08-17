import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { requireUser } from "~/services/session.server";
import {
  newOrganizationPath,
  newProjectPath,
  OrganizationParamsSchema,
  v3ProjectPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  const organization = await prisma.organization.findFirst({
    where: {
      slug: organizationSlug,
      archivedAt: null,
      memberships: { some: { userId: user.id, deactivatedAt: null } },
    },
    include: {
      projects: {
        where: { archivedAt: null },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      },
    },
  });
  if (!organization) throw redirect(newOrganizationPath());
  const project = organization.projects[0];
  if (!project) throw redirect(newProjectPath(organization));
  return redirect(v3ProjectPath(organization, project));
};
