import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { agentPanel } from "~/services/platosAgent.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { organizationSlug, projectParam, envParam } = params;
  if (!organizationSlug || !projectParam || !envParam) throw new Response("Invalid scope", { status: 400 });
  const { scope } = await requireEnvironmentScope({ request, organizationSlug, projectSlug: projectParam, environmentSlug: envParam });
  const [agents, monitoring, tools, approvals] = await Promise.all([
    agentPanel("/api/v1/agent/agents", scope),
    agentPanel("/api/v1/agent/monitoring/summary", scope),
    agentPanel("/api/v1/agent/tools/matrix", scope),
    agentPanel("/api/v1/agent/monitoring/approvals?limit=10", scope),
  ]);
  return json({
    surface: "home" as const,
    title: "Home",
    description: "Current runtime health, reachable work and operator attention for this Environment.",
    panel: { ok: true as const, data: { agents, monitoring, tools, approvals } },
    provenance: "Canonical Agents, monitoring summary, Tool matrix and approval queue endpoints",
  });
}

export default function EnvironmentHomeRoute() {
  return <M4Surface data={useLoaderData<typeof loader>()} />;
}
