import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { agentPanel } from "~/services/platosAgent.server";
import { parseCollectionQuery, withCollectionQuery } from "~/services/pagination.server";
import { agentRequest, booleanField, enumField, jsonArray, jsonObject, m4Mutation, optionalText, requiredText, stringList } from "~/services/m4Mutation.server";

const config = { surface: "channels" as const, title: "Connect and channels", description: "Hosted OAuth ChannelApps and operator-owned ChannelConnections with their complete supported lifecycle.", provenance: "Canonical clean database ancestry and platos-agent API" };

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (!params.organizationSlug || !params.projectParam || !params.envParam) throw new Response("Invalid scope", { status: 400 });
  const { scope } = await requireEnvironmentScope({ request, organizationSlug: params.organizationSlug, projectSlug: params.projectParam, environmentSlug: params.envParam });
  const query = parseCollectionQuery(new URL(request.url), { defaultPageSize: 25, maxPageSize: 100, search: true });
  const [panel, apps, channels] = await Promise.all([
    agentPanel("/api/v1/agent/connect", scope),
    agentPanel(withCollectionQuery("/api/v1/agent/channel-apps", query, { search: true }), scope),
    agentPanel(withCollectionQuery("/api/v1/agent/channels", query, { search: true }), scope),
  ]);
  return json({ ...config, panel, secondary: apps, supporting: channels, collection: query });
}

export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Channel mutation", ({ scope, form }) => {
    const intent = optionalText(form, "intent") ?? "connection-create";
    if (intent === "connection-delete") return agentRequest(`/api/v1/agent/channels/${encodeURIComponent(requiredText(form, "id", "Connection ID"))}`, scope, { method: "DELETE" });
    if (intent === "connection-rotate") return agentRequest(`/api/v1/agent/channels/${encodeURIComponent(requiredText(form, "id", "Connection ID"))}/rotate-secret`, scope, { method: "POST" });
    if (intent === "connection-toggle") return agentRequest(`/api/v1/agent/channels/${encodeURIComponent(requiredText(form, "id", "Connection ID"))}`, scope, { method: "PATCH", body: { enabled: booleanField(form, "enabled") } });
    if (intent === "connection-update") return agentRequest(`/api/v1/agent/channels/${encodeURIComponent(requiredText(form, "id", "Connection ID"))}`, scope, { method: "PATCH", body: { ...(optionalText(form, "displayName") ? { displayName: optionalText(form, "displayName") } : {}), ...(optionalText(form, "agentId") ? { agentId: optionalText(form, "agentId") } : {}), ...(optionalText(form, "agentRouting") ? { agentRouting: jsonArray(form, "agentRouting") } : {}), ...(optionalText(form, "config") ? { config: jsonObject(form, "config") } : {}), ...(optionalText(form, "credentials") ? { credentials: jsonObject(form, "credentials") } : {}) } });
    if (intent === "connection-mint") return agentRequest("/api/v1/agent/channels/mint", scope, { method: "POST", body: { provider: "slack", agentId: requiredText(form, "agentId", "Agent"), displayName: optionalText(form, "displayName"), configToken: requiredText(form, "configToken", "Slack App Configuration Token") } });
    if (intent === "app-delete") return agentRequest(`/api/v1/agent/channel-apps/${encodeURIComponent(requiredText(form, "appId", "Channel App"))}`, scope, { method: "DELETE" });
    if (intent === "app-toggle-ai") return agentRequest(`/api/v1/agent/channel-apps/${encodeURIComponent(requiredText(form, "appId", "Channel App"))}`, scope, { method: "PATCH", body: { aiAppsSurface: booleanField(form, "aiAppsSurface") } });
    if (intent === "app-update") return agentRequest(`/api/v1/agent/channel-apps/${encodeURIComponent(requiredText(form, "appId", "Channel App"))}`, scope, { method: "PATCH", body: { ...(optionalText(form, "displayName") ? { displayName: optionalText(form, "displayName") } : {}), ...(optionalText(form, "clientId") ? { clientId: optionalText(form, "clientId") } : {}), ...(optionalText(form, "clientSecret") ? { clientSecret: optionalText(form, "clientSecret") } : {}), ...(optionalText(form, "signingSecret") ? { signingSecret: optionalText(form, "signingSecret") } : {}), ...(optionalText(form, "scopes") ? { scopes: stringList(form, "scopes") } : {}), ...(optionalText(form, "distribution") ? { distribution: enumField(form, "distribution", ["private", "public"] as const) } : {}), ...(optionalText(form, "linking") ? { linking: enumField(form, "linking", ["none", "optional", "required"] as const) } : {}), ...(optionalText(form, "defaultAgentId") ? { defaultAgentId: optionalText(form, "defaultAgentId") } : {}), ...(optionalText(form, "agentRouting") ? { agentRouting: jsonArray(form, "agentRouting") } : {}) } });
    if (intent === "installation-bind") return agentRequest(`/api/v1/agent/channel-apps/${encodeURIComponent(requiredText(form, "appId", "Channel App"))}/installations/${encodeURIComponent(requiredText(form, "installationId", "Installation"))}/bind`, scope, { method: "POST", body: { agentId: optionalText(form, "agentId") ?? null } });
    if (intent === "installation-revoke") return agentRequest(`/api/v1/agent/channel-apps/${encodeURIComponent(requiredText(form, "appId", "Channel App"))}/installations/${encodeURIComponent(requiredText(form, "installationId", "Installation"))}`, scope, { method: "DELETE" });
    if (intent === "installation-import") {
      const appId = requiredText(form, "appId", "Channel App");
      return agentRequest(`/api/v1/agent/channel-apps/${encodeURIComponent(appId)}/installations/import`, scope, { method: "POST", body: { teamId: optionalText(form, "teamId") ?? null, enterpriseId: optionalText(form, "enterpriseId") ?? null, isEnterpriseInstall: booleanField(form, "isEnterpriseInstall"), teamName: optionalText(form, "teamName") ?? null, botToken: requiredText(form, "botToken", "Bot token"), grantedScopes: stringList(form, "grantedScopes"), agentId: optionalText(form, "agentId") ?? null, agentRouting: jsonArray(form, "agentRouting") } });
    }
    if (intent === "channel-app") return agentRequest("/api/v1/agent/channel-apps", scope, { method: "POST", body: { provider: "slack", displayName: optionalText(form, "displayName"), clientId: requiredText(form, "clientId", "Slack client ID"), clientSecret: requiredText(form, "clientSecret", "Slack client secret"), signingSecret: requiredText(form, "signingSecret", "Slack signing secret"), scopes: stringList(form, "scopes"), distribution: enumField(form, "distribution", ["private", "public"] as const, "private"), aiAppsSurface: booleanField(form, "aiAppsSurface"), linking: enumField(form, "linking", ["none", "optional", "required"] as const, "none"), defaultAgentId: optionalText(form, "defaultAgentId") ?? null, agentRouting: jsonArray(form, "agentRouting") } });
    return agentRequest("/api/v1/agent/channels", scope, { method: "POST", body: { provider: enumField(form, "provider", ["slack", "telegram", "whatsapp", "discord"] as const, "slack"), agentId: requiredText(form, "agentId", "Agent"), displayName: optionalText(form, "displayName"), agentRouting: jsonArray(form, "agentRouting"), credentials: jsonObject(form, "credentials"), config: jsonObject(form, "config") } });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
