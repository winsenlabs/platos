import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "agents" as const, title: "Agents", description: "Configured AI workers in this Environment. Direct and Meta are the only Tool exposure modes; runtime Tools are always present.", endpoint: "/api/v1/agent/agents", secondaryEndpoint: undefined, collection: { defaultPageSize: 25, maxPageSize: 100, search: true, filters: ["status"] }, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
