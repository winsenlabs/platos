import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, jsonObject, m4Mutation, optionalText, requiredText } from "~/services/m4Mutation.server";
const config = { surface: "jobs" as const, title: "Jobs", description: "Platos-native Jobs are distinct from external infrastructure work.", endpoint: "/api/v1/agent/jobs", secondaryEndpoint: undefined, collection: { defaultPageSize: 25, maxPageSize: 100, search: true, filters: ["status"] }, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Job mutation", async ({ scope, form }) => {
    const jobId = encodeURIComponent(requiredText(form, "jobId", "Job"));
    const intent = optionalText(form, "intent") ?? "dispatch";
    if (intent === "delete") return agentRequest(`/api/v1/agent/jobs/${jobId}`, scope, { method: "DELETE" });
    return agentRequest(`/api/v1/agent/jobs/${jobId}/dispatch`, scope, {
      method: "POST",
      body: { payload: jsonObject(form, "dispatchPayload") },
    });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
