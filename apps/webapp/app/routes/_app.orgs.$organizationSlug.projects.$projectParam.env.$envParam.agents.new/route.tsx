import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { mutateAgentConfig } from "~/services/agentConfig.server";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "agent-create", title: "Create Agent", description: "Create the minimum runtime-readable Agent config, then verify a successful Turn.", endpoint: "/api/v1/agent/providers", secondaryEndpoint: "/api/v1/agent/prompt/defaults", provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) { return mutateAgentConfig(args, "create"); }

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }