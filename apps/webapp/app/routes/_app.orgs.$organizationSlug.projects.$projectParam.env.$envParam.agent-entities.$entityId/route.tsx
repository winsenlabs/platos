import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useOutlet } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, booleanField, m4Mutation, optionalText, requiredText, stringList } from "~/services/m4Mutation.server";
const config = { surface: "entities" as const, title: "Entity diagnostics", description: "Live state, current Tool registry, ACL, linked Agents and safe malformed configuration.", endpoint: "/api/v1/agent/entities/:entityId", secondaryEndpoint: "/api/v1/agent/tools/matrix", provenance: "Canonical clean database ancestry and platos-agent API", notFoundAsResponse: true };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Entity mutation", async ({ scope, form }) => {
    const entityId = args.params.entityId;
    if (!entityId) throw new Error("Entity ID is required");
    const encoded = encodeURIComponent(entityId);
    const intent = optionalText(form, "intent") ?? "origins";
    if (intent === "refresh-discovery") {
      return agentRequest(`/api/v1/agent/entities/${encoded}/refresh-discovery`, scope, { method: "POST", body: {} });
    }
    if (intent === "delete") {
      return agentRequest(`/api/v1/agent/entities/${encoded}`, scope, { method: "DELETE" });
    }
    if (intent === "tool-acl") {
      const sourceEntity = requiredText(form, "sourceEntity", "Source Entity");
      const toolName = requiredText(form, "toolName", "Tool name");
      return agentRequest(
        `/api/v1/agent/tools/${encodeURIComponent(sourceEntity)}/${encodeURIComponent(toolName)}/enabled`,
        scope,
        { method: "PATCH", body: { enabled: booleanField(form, "enabled") } },
      );
    }
    return agentRequest(`/api/v1/agent/entities/${encoded}`, scope, {
      method: "PATCH",
      body: { allowedOrigins: stringList(form, "allowedOrigins") },
    });
  });
}

export default function Route() {
  const data = useLoaderData<typeof loader>();
  const outlet = useOutlet();
  return outlet ?? <M4Surface data={data} />;
}
