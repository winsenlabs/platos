import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, m4Mutation } from "~/services/m4Mutation.server";
const config = { surface: "entity-secret", title: "Entity secret rotation", description: "A new Entity secret is revealed once by the API and never persisted in loader data.", endpoint: "/api/v1/agent/entities/:entityId", secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Entity secret rotation", async ({ scope }) => {
    if (!args.params.entityId) throw new Error("Entity ID is required");
    return agentRequest(
      `/api/v1/agent/entities/${encodeURIComponent(args.params.entityId)}/regenerate-secret`,
      scope,
      { method: "POST", body: {} },
    );
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
