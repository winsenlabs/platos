import { ProjectRole } from "@platos/tenancy-database";
import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { requireOperator } from "~/services/auth.server";
import { database } from "~/services/database.server";

const slugify = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

async function membership(request: Request, slug: string) {
  const operator = await requireOperator(request);
  let row;
  try {
    row = await database.organizationMembership.findFirst({
      where: {
        userId: operator.userId,
        deactivatedAt: null,
        organization: { slug, archivedAt: null },
      },
      select: { id: true, organizationId: true },
    });
  } catch {
    throw new Response("Project creation unavailable", { status: 503 });
  }
  if (!row) throw new Response("Forbidden", { status: 403 });
  return row;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await membership(request, params.organizationSlug ?? "");
  return null;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const member = await membership(request, params.organizationSlug ?? "");
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const slug = slugify(String(form.get("slug") ?? name));
  const environmentName = String(form.get("environment") ?? "Production").trim();
  const environmentSlug = slugify(environmentName);
  if (!name || !slug) throw new Response("Project name and slug are required", { status: 400 });
  if (!environmentName || !environmentSlug) throw new Response("Environment name is required", { status: 400 });

  let project;
  try {
    project = await database.$transaction(async (transaction) => {
      const created = await transaction.project.create({
        data: {
          organizationId: member.organizationId,
          name,
          slug,
          environments: { create: { name: environmentName, slug: environmentSlug } },
        },
        select: { id: true, slug: true, environments: { select: { slug: true } } },
      });
      await transaction.projectMembership.create({
        data: {
          projectId: created.id,
          organizationMembershipId: member.id,
          organizationId: member.organizationId,
          role: ProjectRole.ADMIN,
        },
      });
      return created;
    });
  } catch {
    throw new Response("Project creation failed", { status: 503 });
  }
  const environment = project.environments[0];
  if (!environment) throw new Response("Project creation failed", { status: 503 });
  throw redirect(`/orgs/${params.organizationSlug}/projects/${project.slug}/env/${environment.slug}/agents`);
}

export default function NewProject() {
  return (
    <main className="grid min-h-screen place-items-center bg-background-dimmed p-6 text-text-bright">
      <Form method="post" className="w-full max-w-lg rounded-xl border border-grid-bright bg-background-bright p-6">
        <h1 className="text-2xl font-semibold">Create a project</h1>
        <label className="mt-6 block text-sm">
          Project name
          <input name="name" required className="mt-2 w-full rounded border border-grid-bright bg-[var(--bg)] text-text-bright px-3 py-2" />
        </label>
        <label className="mt-4 block text-sm">
          First Environment
          <input name="environment" defaultValue="Production" className="mt-2 w-full rounded border border-grid-bright bg-[var(--bg)] text-text-bright px-3 py-2" />
        </label>
        <button className="mt-4 rounded bg-primary px-4 py-2 text-sm text-white">Create project</button>
      </Form>
    </main>
  );
}
