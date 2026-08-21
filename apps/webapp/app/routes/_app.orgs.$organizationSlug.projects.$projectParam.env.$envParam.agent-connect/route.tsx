import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, booleanField, enumField, jsonArray, jsonObject, m4Mutation, optionalText, requiredText, stringList } from "~/services/m4Mutation.server";
const config = { surface: "channels", title: "Connect and channels", description: "Both hosted OAuth ChannelConnection and operator-owned ChannelApp/Installation models are visible.", endpoint: "/api/v1/agent/connect", secondaryEndpoint: "/api/v1/agent/channel-apps", supportingEndpoint: "/api/v1/agent/channels", provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Channel mutation", async ({ scope, form }) => {
    const intent = optionalText(form, "intent") ?? "connection";
    if (intent === "installation-import") {
      const appId = requiredText(form, "appId", "Channel App");
      return agentRequest(`/api/v1/agent/channel-apps/${encodeURIComponent(appId)}/installations/import`, scope, {
        method: "POST",
        body: {
          teamId: optionalText(form, "teamId") ?? null,
          enterpriseId: optionalText(form, "enterpriseId") ?? null,
          isEnterpriseInstall: booleanField(form, "isEnterpriseInstall"),
          teamName: optionalText(form, "teamName") ?? null,
          botToken: requiredText(form, "botToken", "Bot token"),
          grantedScopes: stringList(form, "grantedScopes"),
          agentId: optionalText(form, "agentId") ?? null,
          agentRouting: jsonArray(form, "agentRouting"),
        },
      });
    }
    if (intent === "channel-app") {
      return agentRequest("/api/v1/agent/channel-apps", scope, {
        method: "POST",
        body: {
          provider: "slack",
          displayName: optionalText(form, "displayName"),
          clientId: requiredText(form, "clientId", "Slack client ID"),
          clientSecret: requiredText(form, "clientSecret", "Slack client secret"),
          signingSecret: requiredText(form, "signingSecret", "Slack signing secret"),
          scopes: stringList(form, "scopes"),
          distribution: enumField(form, "distribution", ["private", "public"] as const, "private"),
          aiAppsSurface: booleanField(form, "aiAppsSurface"),
          linking: enumField(form, "linking", ["none", "optional", "required"] as const, "none"),
          defaultAgentId: optionalText(form, "defaultAgentId") ?? null,
          agentRouting: jsonArray(form, "agentRouting"),
        },
      });
    }
    return agentRequest("/api/v1/agent/channels", scope, {
      method: "POST",
      body: {
        provider: enumField(form, "provider", ["slack", "telegram", "whatsapp", "discord"] as const, "slack"),
        agentId: requiredText(form, "agentId", "Agent"),
        displayName: optionalText(form, "displayName"),
        agentRouting: jsonArray(form, "agentRouting"),
        credentials: jsonObject(form, "credentials"),
        config: jsonObject(form, "config"),
      },
    });
  });
}
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
