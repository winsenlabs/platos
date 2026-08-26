import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { requireEnvironmentScope } from "~/services/auth.server";
import { agentRequest, PlatosAgentApiError } from "~/services/platosAgent.server";
const config = { surface: "tools" as const, title: "Tool registry", description: "Dispatchability, source Entity and health come from the same registry/executor used by runtime Turns.", endpoint: "/api/v1/agent/tools/matrix", collection: { defaultPageSize: 50, maxPageSize: 100, search: true, filters: ["category", "status"] }, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  const { organizationSlug, projectParam: projectSlug, envParam: environmentSlug } = args.params;
  if (!organizationSlug || !projectSlug || !environmentSlug) throw new Response("Invalid scope", { status: 400 });
  const { scope } = await requireEnvironmentScope({ request: args.request, organizationSlug, projectSlug, environmentSlug, access: "secret:mutate" });
  const form = await args.request.formData();
  const toolId = String(form.get("toolId") ?? "");
  const sourceEntityId = String(form.get("sourceEntityId") ?? "");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(toolId) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(sourceEntityId)) return json({ ok: false, error: "Invalid Tool selection" }, { status: 400 });
  try {
    const result = await agentRequest(`/api/v1/agent/tools/${encodeURIComponent(toolId)}/test`, scope, { method: "POST", body: { sourceEntityId, params: {} } });
    return json({ ok: true, result });
  } catch (error) {
    return json({
      ok: false,
      error: "Tool test failed",
      ...(error instanceof PlatosAgentApiError ? { code: error.code } : {}),
    }, { status: error instanceof PlatosAgentApiError ? error.status : 503 });
  }
}
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
