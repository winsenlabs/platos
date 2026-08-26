import {
  OrganizationRole,
  PlatosAuthError,
} from "@platos/tenancy-database";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { operatorAuth, requireOperator } from "~/services/auth.server";
import { database } from "~/services/database.server";

async function load(request: Request, slug: string) {
  const operator = await requireOperator(request);
  let organization;
  try {
    organization = await database.organization.findFirst({
      where: {
        slug,
        archivedAt: null,
        memberships: {
          some: {
            userId: operator.userId,
            deactivatedAt: null,
            role: { in: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
          },
        },
      },
      select: {
        id: true,
        name: true,
        memberships: {
          where: { deactivatedAt: null },
          select: {
            id: true,
            role: true,
            user: { select: { email: true, displayName: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
  } catch {
    throw new Response("Team unavailable", { status: 503 });
  }
  if (!organization) throw new Response("Forbidden", { status: 403 });
  return { operator, organization };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { organization } = await load(request, params.organizationSlug ?? "");
  return json({ organization });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { operator, organization } = await load(request, params.organizationSlug ?? "");
  const form = await request.formData();
  const membershipId = String(form.get("membershipId") ?? "");
  const role = String(form.get("role") ?? "") as OrganizationRole;
  if (!membershipId) throw new Response("Membership is required", { status: 400 });
  if (!Object.values(OrganizationRole).includes(role)) {
    throw new Response("Invalid role", { status: 400 });
  }
  try {
    await operatorAuth.changeMembershipRole({
      organizationId: organization.id,
      membershipId,
      actorUserId: operator.userId,
      role,
    });
  } catch (error) {
    if (error instanceof PlatosAuthError) {
      throw new Response("Membership update failed", { status: error.status });
    }
    throw new Response("Membership update failed", { status: 503 });
  }
  return json({ ok: true });
}

export default function Team() {
  const { organization } = useLoaderData<typeof loader>();
  return (
    <main className="min-h-screen bg-background-dimmed p-8 text-text-bright">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold">{organization.name} members</h1>
        <p className="mt-2 text-sm text-text-dimmed">
          Role changes revoke affected operator sessions immediately.
        </p>
        <div className="mt-6 rounded-lg border border-grid-bright bg-background-bright">
          {organization.memberships.map((membership) => (
            <div
              className="flex items-center justify-between border-b border-grid-bright p-4 last:border-0"
              key={membership.id}
            >
              <div>
                <div>{membership.user.displayName ?? membership.user.email}</div>
                <div className="text-xs text-text-dimmed">{membership.user.email}</div>
              </div>
              <Form method="post" className="flex gap-2">
                <input type="hidden" name="membershipId" value={membership.id} />
                <select
                  name="role"
                  defaultValue={membership.role}
                  className="rounded border border-grid-bright bg-[var(--bg)] text-text-bright px-2 py-1 text-sm"
                >
                  {Object.values(OrganizationRole).map((role) => (
                    <option key={role}>{role}</option>
                  ))}
                </select>
                <button className="rounded border border-grid-bright px-3 py-1 text-sm">Save</button>
              </Form>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
