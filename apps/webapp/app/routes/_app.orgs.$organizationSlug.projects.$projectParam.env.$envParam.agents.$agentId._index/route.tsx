import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { mutateAgentConfig } from "~/services/agentConfig.server";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "agent-config", title: "Agent configuration", description: "Every control maps to persisted AgentVersion fields read by the runtime. Malformed JSON panels fail independently.", endpoint: "/api/v1/agent/agents/:agentId", secondaryEndpoint: "/api/v1/agent/providers", provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) { return mutateAgentConfig(args, "update"); }

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }