import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { parseJobForm } from "~/services/jobConfig.server";
import { agentRequest, jsonObject, m4Mutation, optionalText } from "~/services/m4Mutation.server";
const config = { surface: "jobs" as const, title: "Background Job", description: "Persisted Job state, schedule and execution history.", endpoint: "/api/v1/agent/platos-tasks/:id", parameterAliases: { id: "taskId" }, secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API", notFoundAsResponse: true };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Job mutation", async ({ scope, form }) => {
    if (!args.params.taskId) throw new Error("Job ID is required");
    const taskId = encodeURIComponent(args.params.taskId);
    const intent = optionalText(form, "intent") ?? "update";
    if (intent === "delete") return agentRequest(`/api/v1/agent/platos-tasks/${taskId}`, scope, { method: "DELETE" });
    if (intent === "run") return agentRequest(`/api/v1/agent/platos-tasks/${taskId}/run`, scope, { method: "POST", body: { payload: jsonObject(form, "runPayload") } });
    return agentRequest(`/api/v1/agent/platos-tasks/${taskId}`, scope, { method: "PATCH", body: parseJobForm(form, "update") });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
