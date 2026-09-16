import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet } from "@remix-run/react";
import { requireOperator } from "~/services/auth.server";
import { coreData, type CoreOrganization, type CoreProject } from "~/services/coreApi.server";
import { agentsPath } from "~/utils/pathBuilder";

// A PROJECT URL WITH NO ENVIRONMENT ON IT (WIN-257 T8, route-006).
//
// `database.project.findFirst` with `operatorVisibleProjectWhere` spread into the
// where clause becomes `GET /projects`, which IS that rule, plus
// `GET /organizations` to turn the organization slug into the id the project rows
// are keyed by. Both are keyed by the operator; neither takes a tenant id.
//
// THE 404 STILL HIDES BOTH CASES. The old query returned null for a project that
// does not exist AND for one this operator cannot see, and answered the same
// "Project not found". A project absent from `listVisibleProjects` is
// indistinguishable from one that was never created, so the non-disclosure
// survives without being restated.
//
// THE EARLY RETURN IS UNCHANGED AND STILL LOAD-BEARING. A nested path under this
// route (`/env/:env/...`) is served by its own loader, which does its own
// authorization; running this one there would authorize the same request twice
// and cost a round trip per navigation.

export async function loader({ request, params }: LoaderFunctionArgs) {
  const pathname = new URL(request.url).pathname.replace(/\/$/, "");
  if (!params.organizationSlug || !params.projectParam) throw new Response("Invalid scope", { status: 400 });
  const projectPath = `/orgs/${params.organizationSlug}/projects/${params.projectParam}`;
  if (pathname !== projectPath) return null;
  await requireOperator(request);
  let organizations: readonly CoreOrganization[];
  let projects: readonly CoreProject[];
  try {
    [organizations, projects] = await Promise.all([
      coreData<readonly CoreOrganization[]>("organizations.list", { request }),
      coreData<readonly CoreProject[]>("projects.list", { request }),
    ]);
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Project unavailable", { status: 503 });
  }
  const organization = organizations.find(
    (row) => row.slug === params.organizationSlug && row.archivedAt === null,
  );
  const project = organization
    ? projects.find(
        (row) => row.organizationId === organization.id && row.slug === params.projectParam,
      )
    : undefined;
  const environment = project?.environments[0];
  if (!organization || !project || !environment) throw new Response("Project not found", { status: 404 });
  throw redirect(agentsPath(organization, project, environment));
}

export default function ProjectLayout(){return <Outlet/>;}
