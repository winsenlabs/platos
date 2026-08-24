import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { parseJobForm } from "~/services/jobConfig.server";
import { agentRequest, jsonObject, m4Mutation, optionalText } from "~/services/m4Mutation.server";
const config = { surface: "jobs" as const, title: "Job", description: "Persisted Job state, schedule and execution history.", endpoint: "/api/v1/agent/jobs/:id", parameterAliases: { id: "jobId" }, secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API", notFoundAsResponse: true };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Job mutation", async ({ scope, form }) => {
    if (!args.params.jobId) throw new Error("Job ID is required");
    const jobId = encodeURIComponent(args.params.jobId);
    const intent = optionalText(form, "intent") ?? "update";
    if (intent === "delete") return agentRequest(`/api/v1/agent/jobs/${jobId}`, scope, { method: "DELETE" });
    if (intent === "dispatch") return agentRequest(`/api/v1/agent/jobs/${jobId}/dispatch`, scope, { method: "POST", body: { payload: jsonObject(form, "dispatchPayload") } });
    return agentRequest(`/api/v1/agent/jobs/${jobId}`, scope, { method: "PATCH", body: parseJobForm(form, "update") });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
