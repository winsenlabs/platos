import { redirect, type ActionFunctionArgs } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { requireOperator } from "~/services/auth.server";
import { coreData, type CoreOrganization } from "~/services/coreApi.server";

// FOUNDING AN ORGANIZATION (WIN-257 T8, route-075).
//
// `database.organization.create` with a nested `memberships: { create: { userId,
// role: OWNER } }` — the founder's membership written in the same statement —
// becomes `POST /api/v1/organizations`, which is `createOrganization`. The
// invariant that made the nested write correct (an organization whose founder
// holds no membership is one nobody can reach) is the use case's now, which is
// where M4 keeps it.
//
// THE OWNER ROLE IS NOT SENT. It was `OrganizationRole.OWNER` here, imported from
// the Prisma client; `createOrganization` decides it, because "who founded this"
// is not a field a caller should be able to choose.

const slugify = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

export async function action({ request }: ActionFunctionArgs) {
  await requireOperator(request);
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const slug = slugify(String(form.get("slug") ?? name));
  if (!name || !slug) throw new Response("Name is required", { status: 400 });

  let organization: CoreOrganization;
  try {
    organization = await coreData<CoreOrganization>("organizations.create", {
      request,
      body: { name, slug },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Organization creation failed", { status: 503 });
  }
  throw redirect(`/orgs/${organization.slug}/projects/new`);
}

export default function NewOrg() {
  return (
    <main className="grid min-h-screen place-items-center bg-background-dimmed p-6 text-text-bright">
      <Form method="post" className="w-full max-w-lg rounded-xl border border-grid-bright bg-background-bright p-6">
        <h1 className="text-2xl font-semibold">Create an operator organization</h1>
        <p className="mt-2 text-sm text-text-dimmed">Operator organizations, memberships and invitations are separate from EndUser accounts.</p>
        <label className="mt-6 block text-sm">
          Name
          <input name="name" required className="mt-2 w-full rounded border border-grid-bright bg-[var(--bg)] text-text-bright px-3 py-2" />
        </label>
        <button className="mt-4 rounded bg-primary px-4 py-2 text-sm text-white">Create organization</button>
      </Form>
    </main>
  );
}
