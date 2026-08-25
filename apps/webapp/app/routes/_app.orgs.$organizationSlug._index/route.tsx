import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { requireOperator } from "~/services/auth.server";
import { database } from "~/services/database.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const operator = await requireOperator(request);
  let organization;
  try {
    organization = await database.organization.findFirst({
      where: {
        slug: params.organizationSlug,
        archivedAt: null,
        memberships: { some: { userId: operator.userId, deactivatedAt: null } },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        projects: {
          where: { archivedAt: null },
          select: {
            id: true,
            name: true,
            slug: true,
            environments: {
              where: { archivedAt: null },
              select: { id: true, name: true, slug: true },
            },
          },
        },
      },
    });
  } catch {
    throw new Response("Organization unavailable", { status: 503 });
  }
  if (!organization) throw new Response("Not found", { status: 404 });
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
