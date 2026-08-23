import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, jsonObject, m4Mutation, optionalText } from "~/services/m4Mutation.server";
const config = { surface: "governance" as const, title: "Approval detail", description: "Resolve exactly once; repeated decisions return the persisted outcome.", endpoint: "/api/v1/agent/monitoring/approvals/:approvalId", secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Approval resolution", async ({ scope, form }) => {
    if (!args.params.approvalId) throw new Error("Approval ID is required");
    const approved = optionalText(form, "decision") === "approve";
    return agentRequest(
      `/api/v1/agent/approvals/${encodeURIComponent(args.params.approvalId)}/resolve`,
      scope,
      {
        method: "POST",
        body: {
          approved,
          comment: optionalText(form, "comment"),
          ...(approved && optionalText(form, "editedArgs") ? { editedArgs: jsonObject(form, "editedArgs") } : {}),
        },
      },
    );
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
