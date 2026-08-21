import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, m4Mutation, numberField, optionalText, requiredText } from "~/services/m4Mutation.server";
const config = { surface: "evals", title: "Evaluation criteria", description: "Criterion definitions and judge configuration with cost-lane visibility.", endpoint: "/api/v1/agent/eval-criteria", secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Evaluation criterion creation", async ({ scope, form }) => {
    const scoreScaleMin = numberField(form, "scoreScaleMin", { fallback: 0 });
    const scoreScaleMax = numberField(form, "scoreScaleMax", { fallback: 100 });
    if (scoreScaleMax <= scoreScaleMin) throw new Error("scoreScaleMax must be greater than scoreScaleMin");
    return agentRequest("/api/v1/agent/eval-criteria", scope, {
      method: "POST",
      body: {
        agentId: optionalText(form, "agentId") ?? null,
        name: requiredText(form, "name"),
        description: optionalText(form, "description") ?? null,
        judgePrompt: requiredText(form, "judgePrompt", "Judge prompt"),
        rubric: optionalText(form, "rubric") ?? null,
        judgeModel: optionalText(form, "judgeModel") ?? null,
        scoreScaleMin,
        scoreScaleMax,
      },
    });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
