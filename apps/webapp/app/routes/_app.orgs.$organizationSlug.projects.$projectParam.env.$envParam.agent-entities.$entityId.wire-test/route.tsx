import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, jsonObject, m4Mutation, optionalText } from "~/services/m4Mutation.server";
const config = { surface: "wire-test", title: "Wire test", description: "Run a real gateway Wire test and display the underlying result.", endpoint: "/api/v1/agent/entities/:entityId", secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Wire test", async ({ scope, form }) => {
    if (!args.params.entityId) throw new Error("Entity ID is required");
    return agentRequest(
      `/api/v1/agent/entities/${encodeURIComponent(args.params.entityId)}/wire-test`,
      scope,
      { method: "POST", body: { toolName: optionalText(form, "toolName") ?? "ping", params: jsonObject(form, "params") } },
    );
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
