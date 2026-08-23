import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet } from "@remix-run/react";
import { agentMcpsPath } from "~/utils/pathBuilder";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const pathname = new URL(request.url).pathname.replace(/\/$/, "");
  if (!pathname.endsWith("/settings/integrations")) return null;
  if (!params.organizationSlug || !params.projectParam || !params.envParam) throw new Response("Invalid scope", { status: 400 });
  throw redirect(agentMcpsPath({ slug: params.organizationSlug }, { slug: params.projectParam }, { slug: params.envParam }));
}
export default function Integrations(){return <Outlet/>;}
