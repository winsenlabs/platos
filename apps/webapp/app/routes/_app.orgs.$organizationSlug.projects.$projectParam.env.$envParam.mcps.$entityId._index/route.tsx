import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import {
  agentRequest,
  booleanField,
  enumField,
  jsonObject,
  m4Mutation,
  numberField,
  stringList,
} from "~/services/m4Mutation.server";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "mcp-config", title: "MCP Entity", description: "Safe MCP config, Credential-backed connectivity and current discovery output.", endpoint: "/api/v1/agent/entities/:entityId/mcp/config", secondaryEndpoint: "/api/v1/agent/entities/:entityId", provenance: "Canonical clean database ancestry and platos-agent API", notFoundAsResponse: true };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "MCP Entity configuration", ({ scope, form }) => {
    const entityId = args.params.entityId;
    if (!entityId) throw new Error("Entity is required");
    return agentRequest(`/api/v1/agent/entities/${encodeURIComponent(entityId)}/mcp/config`, scope, {
      method: "PATCH",
      body: {
        enabled: booleanField(form, "enabled"),
        identityMode: enumField(form, "identityMode", ["anonymous", "oidc", "bearer"] as const, "bearer"),
        identityProviders: jsonObject(form, "identityProviders"),
        branding: jsonObject(form, "branding"),
        toolAllowlist: stringList(form, "toolAllowlist"),
        redirectUriAllowlist: stringList(form, "redirectUriAllowlist"),
        rateLimitPerMinute: numberField(form, "rateLimitPerMinute", { min: 1, max: 10_000, integer: true, fallback: 60 }),
      },
    });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
