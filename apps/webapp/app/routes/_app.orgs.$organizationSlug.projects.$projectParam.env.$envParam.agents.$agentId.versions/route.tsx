import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, m4Mutation, requiredText } from "~/services/m4Mutation.server";
const config = { surface: "versions", title: "Agent Versions", description: "Immutable, field-aware config history with readable semantic diffs.", endpoint: "/api/v1/agent/agents/:agentId/versions", secondaryEndpoint: "/api/v1/agent/agents/:agentId", provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Version rollback", async ({ scope, form }) => {
    if (!args.params.agentId) throw new Error("Agent ID is required");
    const versionId = requiredText(form, "versionId", "Version");
    return agentRequest(
      `/api/v1/agent/agents/${encodeURIComponent(args.params.agentId)}/versions/${encodeURIComponent(versionId)}/rollback`,
      scope,
      { method: "POST", body: {} },
    );
  });
}
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
