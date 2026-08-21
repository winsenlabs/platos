import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, m4Mutation, optionalText, requiredText } from "~/services/m4Mutation.server";
const config = { surface: "evals", title: "Evaluations", description: "Regression sweeps, criterion outcomes and judge-lane cost.", endpoint: "/api/v1/agent/evals", secondaryEndpoint: "/api/v1/agent/eval-criteria", provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Evaluation run", async ({ scope, form }) => agentRequest(
    "/api/v1/agent/evals/run",
    scope,
    {
      method: "POST",
      body: {
        agentId: requiredText(form, "agentId", "Agent"),
        threadId: requiredText(form, "threadId", "Thread"),
        criterionId: requiredText(form, "criterionId", "Criterion"),
        messageId: optionalText(form, "messageId"),
        baselineVersionId: optionalText(form, "baselineVersionId"),
      },
    },
  ));
}
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
