import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest } from "~/services/platosAgent.server";

const config = { surface: "agent-tools" as const, title: "Agent Tool exposure", description: "Shows Tools injected this Turn, find-only Tools, always-present runtime Tools, source Entity and live dispatchability.", endpoint: "/api/v1/agent/agents/:agentId/tool-mappings", collection: { defaultPageSize: 50, maxPageSize: 100, search: true }, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }

export async function action(args: ActionFunctionArgs) {
  const organizationSlug = args.params.organizationSlug;
  const projectSlug = args.params.projectParam;
  const environmentSlug = args.params.envParam;
  if (!organizationSlug || !projectSlug || !environmentSlug) throw new Response("Invalid scope", { status: 400 });
  const { scope } = await requireEnvironmentScope({ request: args.request, organizationSlug, projectSlug, environmentSlug, access: "secret:mutate" });
  const form = await args.request.formData();
  const sourceEntity = String(form.get("sourceEntity") ?? "").trim();
  const toolName = String(form.get("toolName") ?? "").trim();
  const enabled = form.get("enabled") === "true";
  if (!sourceEntity || !toolName) return json({ ok: false, error: "Tool mapping identity is required" }, { status: 400 });
  try {
    const result = await agentRequest(
      `/api/v1/agent/tools/${encodeURIComponent(sourceEntity)}/${encodeURIComponent(toolName)}/enabled`,
      scope,
      { method: "PATCH", body: { enabled } },
    );
    return json({ ok: true, result });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Tool mapping update failed" }, { status: 400 });
  }
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
