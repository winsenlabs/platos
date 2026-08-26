import { redirect, type LoaderFunctionArgs } from "@remix-run/node";

export async function loader({ params }: LoaderFunctionArgs) {
  if (!params.organizationSlug) throw new Response("Invalid scope", { status: 400 });
  throw redirect(`/orgs/${encodeURIComponent(params.organizationSlug)}/settings/team`);
}
