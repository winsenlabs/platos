import { json, type ActionFunctionArgs } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { requireOperator } from "~/services/auth.server";
import {
  CoreApiError,
  coreData,
  type CoreIssuedInvitation,
  type CoreOrganization,
} from "~/services/coreApi.server";

// INVITING AN OPERATOR (WIN-257 T8, route-005) — AND THE RULE THAT USED TO LIVE
// IN THIS FILE.
//
// The `organization.findFirst` over `role: { in: [OWNER, ADMIN] }` above the
// `operatorAuth.issueInvitation` call WAS the authorization rule. The tenancy
// contract said so in as many words — "issueInvitation is gated only by its
// caller" — and `invitations.ts` recorded it as "ONE GAP, RECORDED NOT
// INVENTED". Deleting this route without moving the gate would have deleted the
// only thing standing between any active member and an invitation.
//
// D1 (2026-09-15) decided it and `issueInvitation` now enforces it: only an
// ACTIVE member with the role OWNER or ADMIN of the target organization may
// issue, and any other caller is refused with a DISTINCT code. So this route no
// longer holds a gate — holding a second copy would be two guards for one rule,
// and the copy here is the one that would go stale.
//
// THE ORGANIZATION ID STILL COMES FROM A LIST KEYED BY THE OPERATOR. The URL
// carries a slug and the V1 route takes an id; `GET /organizations` is
// `listOperatorOrganizations`, so a slug this operator cannot reach resolves to
// nothing and the 403 is answered without an invitation ever being attempted.
// That is resolution, not authorization: membership alone puts an organization
// in that list, and OWNER/ADMIN is the rule, which is D1's to apply.
//
// THE ROLE IS STILL NAMED. `MEMBER` was `OrganizationRole.MEMBER` imported from
// the Prisma client and is now a string the contract validates: this screen
// invites members, and an invite form that silently minted admins would be a
// privilege escalation nobody asked for.

export async function action({ request, params }: ActionFunctionArgs) {
  await requireOperator(request);
  let organizations: readonly CoreOrganization[];
  try {
    organizations = await coreData<readonly CoreOrganization[]>("organizations.list", { request });
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Invitation service is unavailable", { status: 503 });
  }
  const organization = organizations.find((row) => row.slug === params.organizationSlug);
  if (!organization) throw new Response("Forbidden", { status: 403 });

  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw new Response("Valid email is required", { status: 400 });
  }
  try {
    const issued = await coreData<CoreIssuedInvitation>("organizations.invitations.issue", {
      request,
      parameters: { organizationId: organization.id },
      body: { email, role: "MEMBER" },
    });
    // `invitationId` ONLY. The V1 resource carries no token — D1's rule is about
    // who may issue, and `issueInvitation` returns the id, the expiry and how
    // many earlier invitations it superseded. There has never been a
    // login-capable value on this response and there is none now.
    return json({ ok: true, invitationId: issued.invitationId });
  } catch (error) {
    if (error instanceof Response) throw error;
    // D1's refusal is a 403 and it keeps its status here, so a member who may
    // not invite is told that rather than told the service is down.
    throw new Response("Invitation service is unavailable", {
      status: error instanceof CoreApiError && error.status === 403 ? 403 : 503,
    });
  }
}

export default function Invite() {
  const result = useActionData<typeof action>();
  return (
    <main className="grid min-h-screen place-items-center bg-background-dimmed text-text-bright">
      <Form method="post" className="w-full max-w-lg rounded-lg border border-grid-bright bg-background-bright p-6">
        <h1 className="text-xl font-semibold">Invite an operator</h1>
        <input name="email" type="email" required className="mt-5 w-full rounded border border-grid-bright bg-charcoal-900 px-3 py-2" />
        <button className="mt-4 rounded bg-indigo-500 px-4 py-2">Create invitation</button>
        {result?.ok && <p className="mt-3 text-sm text-green-300">Invitation created. Delivery is handled by the configured operator channel.</p>}
      </Form>
    </main>
  );
}
