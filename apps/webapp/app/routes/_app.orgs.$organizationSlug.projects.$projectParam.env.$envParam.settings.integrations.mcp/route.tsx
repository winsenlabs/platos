import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { agentMcpsPath } from "~/utils/pathBuilder";

export async function loader({ params }: LoaderFunctionArgs) {
  if (!params.organizationSlug || !params.projectParam || !params.envParam) throw new Response("Invalid scope", { status: 400 });
  throw redirect(agentMcpsPath({ slug: params.organizationSlug }, { slug: params.projectParam }, { slug: params.envParam }));
}

export default function McpSettingsRedirect() { return null; }
