import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest } from "~/services/platosAgent.server";

const config = { surface: "canary", title: "Canary rollout", description: "Metrics join persisted AgentBinding, AgentVersion, Turn and Step cohort columns; promotion changes runtime selection.", endpoint: "/api/v1/agent/agents/:agentId/canary/metrics?hours=24", secondaryEndpoint: "/api/v1/agent/agents/:agentId/versions?take=200", provenance: "Persisted AgentBinding cohorts and usage-ledger projections from canonical Turn and Step columns" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }

export async function action(args: ActionFunctionArgs) {
  const organizationSlug = args.params.organizationSlug;
  const projectSlug = args.params.projectParam;
  const environmentSlug = args.params.envParam;
  const agentId = args.params.agentId;
  if (!organizationSlug || !projectSlug || !environmentSlug || !agentId) throw new Response("Invalid scope", { status: 400 });
  const { scope } = await requireEnvironmentScope({ request: args.request, organizationSlug, projectSlug, environmentSlug, access: "secret:mutate" });
  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "promote") {
      const result = await agentRequest(`/api/v1/agent/agents/${encodeURIComponent(agentId)}/canary/promote`, scope, { method: "POST" });
      return json({ ok: true, result });
    }
    if (intent === "set") {
      const canaryPercent = Number(form.get("canaryPercent"));
      const canaryVersionId = String(form.get("canaryVersionId") ?? "").trim() || null;
      if (!Number.isInteger(canaryPercent) || canaryPercent < 0 || canaryPercent > 100 || (canaryPercent > 0 && !canaryVersionId)) {
        return json({ ok: false, error: "Choose a canary version and a whole percent from 0 to 100" }, { status: 400 });
      }
      const result = await agentRequest(`/api/v1/agent/agents/${encodeURIComponent(agentId)}/canary`, scope, {
        method: "PATCH",
        body: { canaryVersionId, canaryPercent },
      });
      return json({ ok: true, result });
    }
    return json({ ok: false, error: "Unsupported canary operation" }, { status: 400 });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Canary operation failed" }, { status: 400 });
  }
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
