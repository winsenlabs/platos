import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { requireOperator } from "~/services/auth.server";
import { database } from "~/services/database.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const operator = await requireOperator(request);
  let membership;
  try {
    membership = await database.organizationMembership.findFirst({
      where: {
        userId: operator.userId,
        deactivatedAt: null,
        organization: { archivedAt: null },
      },
      select: {
        organization: {
          select: {
            id: true,
            slug: true,
            projects: {
              where: { archivedAt: null },
              orderBy: { createdAt: "asc" },
              take: 1,
              select: {
                id: true,
                slug: true,
                environments: {
                  where: { archivedAt: null },
                  orderBy: { createdAt: "asc" },
                  take: 1,
                  select: { id: true, slug: true },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  } catch {
    throw new Response("Organizations unavailable", { status: 503 });
  }
  const project = membership?.organization.projects[0];
  const environment = project?.environments[0];
  if (membership && project && environment) {
    throw redirect(
      `/orgs/${membership.organization.slug}/projects/${project.slug}/env/${environment.slug}/agents`,
    );
  }
  throw redirect("/orgs/new");
}
