import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { agentRequest, m4Mutation, requiredText } from "~/services/m4Mutation.server";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "skills", title: "Install Skill", description: "Install embedded official Skill configuration or import a custom package.", endpoint: "/api/v1/agent/skills", secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Skill import", ({ scope, form }) =>
    agentRequest("/api/v1/agent/skills/import", scope, {
      method: "POST",
      body: { url: requiredText(form, "url", "Skill URL") },
    }),
  );
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
