import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { requireOperator } from "~/services/auth.server";
import {
  CoreApiError,
  coreData,
  type CoreCreatedProject,
  type CoreOrganization,
} from "~/services/coreApi.server";

// FOUNDING A PROJECT (WIN-257 T8, route-074).
//
// THREE ROWS IN ONE TRANSACTION, AND THIS ROUTE NO LONGER KNOWS THAT. The action
// ran `database.$transaction` around `project.create` (with a nested
// `environments: { create }`) and `projectMembership.create`, and a
// `organizationMembership.findFirst` before it as the membership gate.
// `POST /api/v1/projects` is `createProject`, which commits the project, its
// first environment and the creator's ADMIN membership in one unit of work
// because "a project with no environment is unreachable" and one whose creator
// holds no membership "is lost to any creator who is not already an organization
// admin". The invariant is the use case's; this route passes five fields.
//
// THE MEMBERSHIP GATE MOVED, AND DELIBERATELY DID NOT STAY HERE TOO. The old
// `findFirst` answered 403 before the transaction opened. `createProject`
// answers `TENANCY_PROJECT_CREATION_FORBIDDEN` with a `details.reason` of
// `no-such-organization`, `organization-archived`, `not-a-member` or
// `membership-deactivated`. A transport that pre-checked would hold half of that
// decision, and its half would be the one that went stale.
//
// THE ORGANIZATION ID IS STILL RESOLVED HERE, because the URL carries a SLUG and
// the V1 create takes an ID. It comes from `GET /organizations`, which is keyed
// by the operator: a slug the operator cannot reach resolves to nothing and this
// route answers the 403 it always answered, without the create ever being made.

const slugify = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

async function organization(request: Request, slug: string): Promise<CoreOrganization> {
  await requireOperator(request);
  let organizations: readonly CoreOrganization[];
  try {
    organizations = await coreData<readonly CoreOrganization[]>("organizations.list", { request });
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Project creation unavailable", { status: 503 });
  }
  const found = organizations.find((row) => row.slug === slug && row.archivedAt === null);
  if (!found) throw new Response("Forbidden", { status: 403 });
  return found;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await organization(request, params.organizationSlug ?? "");
  return null;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const owner = await organization(request, params.organizationSlug ?? "");
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const slug = slugify(String(form.get("slug") ?? name));
  const environmentName = String(form.get("environment") ?? "Production").trim();
  const environmentSlug = slugify(environmentName);
  if (!name || !slug) throw new Response("Project name and slug are required", { status: 400 });
  if (!environmentName || !environmentSlug) throw new Response("Environment name is required", { status: 400 });

  let created: CoreCreatedProject;
  try {
    created = await coreData<CoreCreatedProject>("projects.create", {
      request,
      body: { organizationId: owner.id, name, slug, environmentName, environmentSlug },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    // A refusal the use case owns keeps its status — 403 for a membership the
    // creator does not hold — so the page still distinguishes "you may not" from
    // "this broke". The message stays the stable one; `details.reason` is the
    // core process's to log, not this page's to publish.
    throw new Response("Project creation failed", {
      status: error instanceof CoreApiError && error.status === 403 ? 403 : 503,
    });
  }
  throw redirect(
    `/orgs/${params.organizationSlug}/projects/${created.project.slug}/env/${created.environment.slug}/agents`,
  );
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
