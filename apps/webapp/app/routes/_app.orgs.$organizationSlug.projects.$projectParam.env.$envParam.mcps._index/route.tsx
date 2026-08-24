import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "entities" as const, title: "MCP entities", description: "Outbound MCP clients share the canonical Entity registry, live discovery and Credential references.", endpoint: "/api/v1/agent/entities?connectionKind=mcp", secondaryEndpoint: "/api/v1/agent/tools/matrix?limit=25", collection: { defaultPageSize: 25, maxPageSize: 100, search: true }, provenance: "Canonical MCP Entity rows, live discovery and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
