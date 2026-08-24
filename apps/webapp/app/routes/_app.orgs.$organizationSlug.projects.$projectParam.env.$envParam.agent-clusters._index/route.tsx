import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, m4Mutation, optionalText, requiredText, stringList } from "~/services/m4Mutation.server";
const config = { surface: "clusters" as const, title: "Agent clusters", description: "Adding an Agent widens the memory recall scope; review that consequence before saving.", endpoint: "/api/v1/agent/clusters", collection: { defaultPageSize: 25, maxPageSize: 100, search: true }, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Cluster creation", async ({ scope, form }) => agentRequest(
    "/api/v1/agent/clusters",
    scope,
    {
      method: "POST",
      body: {
        name: requiredText(form, "name"),
        slug: requiredText(form, "slug"),
        description: optionalText(form, "description"),
        primaryAgentId: optionalText(form, "primaryAgentId"),
        agentIds: stringList(form, "agentIds"),
      },
    },
  ));
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
