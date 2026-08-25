import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet } from "@remix-run/react";
import { requireOperator } from "~/services/auth.server";
import { database } from "~/services/database.server";
import { agentsPath } from "~/utils/pathBuilder";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const pathname = new URL(request.url).pathname.replace(/\/$/, "");
  if (!params.organizationSlug || !params.projectParam) throw new Response("Invalid scope", { status: 400 });
  const projectPath = `/orgs/${params.organizationSlug}/projects/${params.projectParam}`;
  if (pathname !== projectPath) return null;
  const operator = await requireOperator(request);
  let project;
  try {
    project = await database.project.findFirst({
      where: {
        slug: params.projectParam,
        archivedAt: null,
        organization: {
          slug: params.organizationSlug,
          archivedAt: null,
          memberships: { some: { userId: operator.userId, deactivatedAt: null } },
        },
      },
      select: { id: true, slug: true, organization: { select: { id: true, slug: true } }, environments: { where: { archivedAt: null }, orderBy: { createdAt: "asc" }, take: 1, select: { id: true, slug: true } } },
    });
  } catch {
    throw new Response("Project unavailable", { status: 503 });
  }
  const environment = project?.environments[0];
  if (!project || !environment) throw new Response("Project not found", { status: 404 });
  throw redirect(agentsPath(project.organization, project, environment));
}

export default function ProjectLayout(){return <Outlet/>;}
