import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, jsonObject, m4Mutation, optionalText, requiredText } from "~/services/m4Mutation.server";
const config = { surface: "jobs" as const, title: "Platos background work", description: "Job-backed Platos work is distinct from external infrastructure tasks.", endpoint: "/api/v1/agent/platos-tasks", secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Job mutation", async ({ scope, form }) => {
    const taskId = encodeURIComponent(requiredText(form, "taskId", "Job"));
    const intent = optionalText(form, "intent") ?? "run";
    if (intent === "delete") return agentRequest(`/api/v1/agent/platos-tasks/${taskId}`, scope, { method: "DELETE" });
    return agentRequest(`/api/v1/agent/platos-tasks/${taskId}/run`, scope, {
      method: "POST",
      body: { payload: jsonObject(form, "runPayload") },
    });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
