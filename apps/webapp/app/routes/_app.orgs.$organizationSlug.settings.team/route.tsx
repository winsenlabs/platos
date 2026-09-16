import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { requireOperator } from "~/services/auth.server";
import {
  CoreApiError,
  coreData,
  type CoreOrganization,
  type CoreOrganizationMember,
} from "~/services/coreApi.server";
import { ORGANIZATION_ROLES, isOrganizationRole } from "~/utils/coreVocabulary";

// THE TEAM SCREEN (WIN-257 T8, route-073).
//
// `database.organization.findFirst` with `role: { in: [OWNER, ADMIN] }` and a
// nested `memberships` select carrying each member's `user.email` becomes
// `GET /api/v1/organizations/:organizationId/members`, which is
// `listOrganizationMembers` — refused `TENANCY_MEMBER_LIST_FORBIDDEN` unless the
// ACTOR is an active OWNER/ADMIN. The gate this file used to hold is the
// contract's, so deleting the Prisma read deletes no authorization; keeping a
// copy here would be a second guard for one rule.
//
// THE SLUG STILL HAS TO BECOME AN ID, and `GET /organizations` does that keyed by
// the operator. That lookup is RESOLUTION AND NOT THE GATE: plain membership puts
// an organization in that list, and a MEMBER who reaches this screen is refused
// by the member listing itself — which is exactly the 403 this route answered
// before, decided one layer deeper.
//
// `changeMembershipRole` was already on the contract before this tranche and is
// now reachable: `PATCH /organizations/:organizationId/members/:membershipId`.
// The page's own text — "Role changes revoke affected operator sessions
// immediately" — is that use case's behaviour and stays true.

async function load(request: Request, slug: string) {
  const operator = await requireOperator(request);
  let organizations: readonly CoreOrganization[];
  try {
    organizations = await coreData<readonly CoreOrganization[]>("organizations.list", { request });
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Team unavailable", { status: 503 });
  }
  const found = organizations.find((row) => row.slug === slug && row.archivedAt === null);
  if (!found) throw new Response("Forbidden", { status: 403 });

  let members: readonly CoreOrganizationMember[];
  try {
    members = await coreData<readonly CoreOrganizationMember[]>("organizations.members.list", {
      request,
      parameters: { organizationId: found.id },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    // A MEMBER asking for the team list is refused by the contract; that is the
    // 403 the Prisma gate used to answer and it keeps its status.
    if (error instanceof CoreApiError && (error.status === 403 || error.status === 404)) {
      throw new Response("Forbidden", { status: 403 });
    }
    throw new Response("Team unavailable", { status: 503 });
  }
  return {
    operator,
    organization: {
      id: found.id,
      name: found.name,
      memberships: members.map((member) => ({
        id: member.membershipId,
        role: member.role,
        user: { email: member.email, displayName: member.displayName },
      })),
    },
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { organization } = await load(request, params.organizationSlug ?? "");
  return json({ organization });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { organization } = await load(request, params.organizationSlug ?? "");
  const form = await request.formData();
  const membershipId = String(form.get("membershipId") ?? "");
  const role = String(form.get("role") ?? "");
  if (!membershipId) throw new Response("Membership is required", { status: 400 });
  // THE ROLE IS STILL VALIDATED HERE, and not because the contract does not. The
  // form is a `<select>` this page renders; an unknown value in it is a malformed
  // SUBMISSION and 400 is what this route answered for it. Forwarding it so the
  // contract could answer would turn a form bug into a round trip and a
  // different status.
  if (!isOrganizationRole(role)) throw new Response("Invalid role", { status: 400 });
  try {
    await coreData("organizations.members.changeRole", {
      request,
      parameters: { organizationId: organization.id, membershipId },
      body: { role },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Membership update failed", {
      status: error instanceof CoreApiError && error.status >= 400 && error.status <= 599
        ? error.status
        : 503,
    });
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
                  {ORGANIZATION_ROLES.map((role) => (
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
