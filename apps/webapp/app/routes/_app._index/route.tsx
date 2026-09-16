import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { requireOperator } from "~/services/auth.server";
import { coreData, type CoreOrganization, type CoreProject } from "~/services/coreApi.server";

// WHERE DOES THIS OPERATOR LAND? (WIN-257 T8, route-002)
//
// This was one `database.organizationMembership.findFirst` with a three-level
// nested select, and it folded three decisions together: which organizations are
// mine, which projects can I see inside the oldest one, and which environment do
// I land in. The middle one was `operatorVisibleProjectWhere` — an authorization
// rule that existed nowhere in this product except as a
// `Prisma.ProjectWhereInput` in this tree.
//
// It is now two reads, both keyed by the operator alone: `GET /organizations` is
// `listOperatorOrganizations`, `GET /projects` is `listVisibleProjects`, and
// `listVisibleProjects` IS that rule, ported. NEITHER REQUEST CARRIES A TENANT
// ID, so there is nothing in either for a caller to substitute — which is why
// this route needs no scope check of its own and must not invent one.
//
// THE ORDER IS THE ORACLE'S, AND IT IS THE BEHAVIOUR. `orderBy: { createdAt:
// "asc" }` on the membership decided which organization an operator lands in,
// and the same clause with `take: 1` on the nested `projects` decided which
// project inside it. `operator-read-models.ts` sorts both by creation with the id
// as the tiebreak and says why; taking the first of each here is what `take: 1`
// meant.

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOperator(request);
  let organizations: readonly CoreOrganization[];
  let projects: readonly CoreProject[];
  try {
    [organizations, projects] = await Promise.all([
      coreData<readonly CoreOrganization[]>("organizations.list", { request }),
      coreData<readonly CoreProject[]>("projects.list", { request }),
    ]);
  } catch (error) {
    // A thrown `Response` is the /login redirect and must travel. Everything
    // else answers the stable message and status this route already answered
    // when the Prisma read threw; nothing from the upstream body is reflected.
    if (error instanceof Response) throw error;
    throw new Response("Organizations unavailable", { status: 503 });
  }

  // The oldest organization this operator is a live member of, then the oldest
  // project inside IT that the visibility rule admits, then that project's
  // oldest live environment. An organization with no landable project is SKIPPED
  // rather than landed on, which is what the nested select did: a membership
  // whose nested `projects` came back empty produced no redirect target and the
  // query moved on.
  for (const organization of organizations) {
    const project = projects.find(
      (row) => row.organizationId === organization.id && row.environments.length > 0,
    );
    const environment = project?.environments[0];
    if (project === undefined || environment === undefined) continue;
    throw redirect(
      `/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/agents`,
    );
  }
  throw redirect("/orgs/new");
}
