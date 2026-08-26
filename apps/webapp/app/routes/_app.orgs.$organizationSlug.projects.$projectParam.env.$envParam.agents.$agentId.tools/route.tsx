import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, PlatosAgentApiError } from "~/services/platosAgent.server";

const config = { surface: "agent-tools" as const, title: "Agent Tool exposure", description: "Shows Tools injected this Turn, find-only Tools, always-present runtime Tools, source Entity and live dispatchability.", endpoint: "/api/v1/agent/agents/:agentId/tool-mappings", collection: { defaultPageSize: 50, maxPageSize: 100, search: true }, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }

export async function action(args: ActionFunctionArgs) {
  const organizationSlug = args.params.organizationSlug;
  const projectSlug = args.params.projectParam;
  const environmentSlug = args.params.envParam;
  const agentId = args.params.agentId?.trim();
  if (!organizationSlug || !projectSlug || !environmentSlug || !agentId) throw new Response("Invalid scope", { status: 400 });
  const { scope } = await requireEnvironmentScope({ request: args.request, organizationSlug, projectSlug, environmentSlug, access: "secret:mutate" });
  const form = await args.request.formData();
  const toolId = String(form.get("toolId") ?? "").trim();
  const enabledRaw = form.get("enabled");
  if (!toolId || (enabledRaw !== "true" && enabledRaw !== "false")) {
    return json({ ok: false, code: "invalid_agent_tool_mapping_request", error: "Agent Tool mapping identity and enabled state are required" }, { status: 400 });
  }
  const enabled = enabledRaw === "true";
  try {
    const result = await agentRequest(
      `/api/v1/agent/agents/${encodeURIComponent(agentId)}/tool-mappings/${encodeURIComponent(toolId)}`,
      { ...scope, agentId },
      { method: "PATCH", body: { enabled } },
    );
    return json({ ok: true, result });
  } catch (error) {
    if (error instanceof PlatosAgentApiError) {
      return json({ ok: false, code: error.code, error: "Agent Tool mapping update failed" }, { status: error.status });
    }
    return json({ ok: false, code: "agent_tool_mapping_unavailable", error: "Agent Tool mapping update is unavailable" }, { status: 503 });
  }
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
