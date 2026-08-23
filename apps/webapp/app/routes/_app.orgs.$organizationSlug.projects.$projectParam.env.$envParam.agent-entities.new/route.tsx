import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, enumField, jsonObject, m4Mutation, optionalText, requiredText, stringList } from "~/services/m4Mutation.server";
const config = { surface: "entity-create" as const, title: "Connect Entity", description: "Register Wire or MCP ownership and run real discovery through the runtime gateway.", endpoint: "/api/v1/agent/entities/check-availability", secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Entity registration", async ({ scope, form }) => {
    const connectionKind = enumField(form, "connectionKind", ["wire", "mcp"] as const, "wire");
    const body: Record<string, unknown> = {
      entityId: requiredText(form, "entityId", "Entity ID"),
      displayName: requiredText(form, "displayName", "Display name"),
      connectionKind,
    };
    if (connectionKind === "wire") {
      body.mcpUrls = stringList(form, "mcpUrls");
    } else {
      const transport = enumField(
        form,
        "transport",
        ["remote-http", "remote-sse", "hosted-composio", "hosted-linear"] as const,
        "remote-http",
      );
      const url = optionalText(form, "url") ?? null;
      if ((transport === "remote-http" || transport === "remote-sse") && !url) {
        throw new Error("URL is required for remote MCP transports");
      }
      body.mcpClient = {
        transport,
        url,
        credsSecretKey: optionalText(form, "credsSecretKey") ?? null,
        headersTemplate: jsonObject(form, "headersTemplate"),
      };
    }
    return agentRequest("/api/v1/agent/entities", scope, { method: "POST", body });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
