import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "versions", title: "Evaluation A/B", description: "Compare immutable AgentVersion cohorts, per-criterion judge results and judge cost lane.", endpoint: "/api/v1/agent/agents/:agentId/versions", secondaryEndpoint: "/api/v1/agent/agents/:agentId/evals/aggregate?days=30", provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }