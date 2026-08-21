import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { parseJobForm } from "~/services/jobConfig.server";
import { agentRequest, m4Mutation } from "~/services/m4Mutation.server";
const config = { surface: "jobs", title: "Create background Job", description: "Create Platos-native scheduled work without Trigger UI ownership.", endpoint: "/api/v1/agent/platos-tasks", secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Job creation", async ({ scope, form }) => agentRequest(
    "/api/v1/agent/platos-tasks",
    scope,
    { method: "POST", body: parseJobForm(form, "create") },
  ));
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
