import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, m4Mutation, optionalText, requiredText } from "~/services/m4Mutation.server";
const config = { surface: "clusters" as const, title: "Cluster memory scope", description: "Explicit membership and the resulting widened runtime recall boundary.", endpoint: "/api/v1/agent/clusters/:clusterId", secondaryEndpoint: "/api/v1/agent/agents", provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Cluster mutation", async ({ scope, form }) => {
    if (!args.params.clusterId) throw new Error("Cluster ID is required");
    const clusterId = encodeURIComponent(args.params.clusterId);
    const intent = optionalText(form, "intent") ?? "update";
    if (intent === "delete") {
      return agentRequest(`/api/v1/agent/clusters/${clusterId}`, scope, { method: "DELETE" });
    }
    if (intent === "add-agent") {
      return agentRequest(`/api/v1/agent/clusters/${clusterId}/agents`, scope, {
        method: "POST",
        body: { agentId: requiredText(form, "agentId", "Agent"), role: optionalText(form, "role") },
      });
    }
    if (intent === "remove-agent") {
      const agentId = requiredText(form, "agentId", "Agent");
      return agentRequest(`/api/v1/agent/clusters/${clusterId}/agents/${encodeURIComponent(agentId)}`, scope, { method: "DELETE" });
    }
    return agentRequest(`/api/v1/agent/clusters/${clusterId}`, scope, {
      method: "PATCH",
      body: {
        name: optionalText(form, "name"),
        slug: optionalText(form, "slug"),
        description: optionalText(form, "description"),
        primaryAgentId: optionalText(form, "primaryAgentId"),
      },
    });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
