import { redirect, type LoaderFunctionArgs } from "@remix-run/node";

export async function loader({ params }: LoaderFunctionArgs) {
  const { organizationSlug, projectParam, envParam, threadId } = params;
  if (!organizationSlug || !projectParam || !envParam || !threadId) throw new Response("Invalid scope", { status: 400 });
  return redirect(`/orgs/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectParam)}/env/${encodeURIComponent(envParam)}/threads/${encodeURIComponent(threadId)}/trace`);
}

export default function CanonicalTraceRedirect() { return null; }
