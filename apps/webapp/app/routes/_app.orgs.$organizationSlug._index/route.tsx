import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { requireOperator } from "~/services/auth.server";
import { coreData, type CoreOrganization, type CoreProject } from "~/services/coreApi.server";

// ONE ORGANIZATION AND THE PROJECTS INSIDE IT (WIN-257 T8, route-004).
//
// `database.organization.findFirst` with `memberships: { some: { userId,
// deactivatedAt: null } }` as the gate and `operatorVisibleProjectWhere` on the
// nested projects becomes two reads that are both keyed by the operator alone:
// `GET /organizations` (`listOperatorOrganizations`, which applies the
// membership gate) and `GET /projects` (`listVisibleProjects`, which is the
// visibility rule). The slug in the URL then SELECTS from what came back.
//
// THAT IS WHY THE 404 IS STILL A 404 AND STILL MEANS THE SAME THING. The old
// query returned null both for an organization that does not exist and for one
// this operator is not a live member of, and answered the same stable "Not
// found" for both — a deliberate non-disclosure. Filtering the two lists by slug
// reproduces it exactly: an organization missing from `listOperatorOrganizations`
// is indistinguishable from one that was never created.
//
// NO PER-PROJECT ROUND TRIP. The environments each project links to come back on
// the project rows themselves (`ProjectResource.environments`, WIN-257 T8), which
// is the nested `environments` select this query carried.

export async function loader({ request, params }: LoaderFunctionArgs) {
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
    throw new Response("Organization unavailable", { status: 503 });
  }
  const found = organizations.find(
    (row) => row.slug === params.organizationSlug && row.archivedAt === null,
  );
  if (!found) throw new Response("Not found", { status: 404 });
  const organization = {
    id: found.id,
    name: found.name,
    slug: found.slug,
    projects: projects
      .filter((project) => project.organizationId === found.id)
      .map((project) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
        environments: project.environments.map((environment) => ({
          id: environment.id,
          name: environment.name,
          slug: environment.slug,
        })),
      })),
  };
  return json({ organization });
}

export default function Org() {
  const { organization } = useLoaderData<typeof loader>();
  return (
    <main className="min-h-screen bg-background-dimmed p-8 text-text-bright">
      <div className="mx-auto max-w-5xl">
        <div className="flex justify-between">
          <h1 className="text-2xl font-semibold">{organization.name}</h1>
          <Link className="rounded bg-primary text-white px-4 py-2 text-sm" to="projects/new">
            New project
          </Link>
        </div>
        <div className="mt-6 grid gap-3">
          {organization.projects.map((project) => (
            <div className="rounded-lg border border-grid-bright bg-background-bright p-4" key={project.slug}>
              <h2 className="font-medium">{project.name}</h2>
              <div className="mt-3 flex gap-2">
                {project.environments.map((environment) => (
                  <Link
                    className="rounded border border-grid-bright px-3 py-1 text-sm"
                    key={environment.slug}
                    to={`projects/${project.slug}/env/${environment.slug}/agents`}
                  >
                    {environment.name}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
