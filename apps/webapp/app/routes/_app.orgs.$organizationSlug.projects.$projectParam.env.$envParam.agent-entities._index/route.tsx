import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "entities" as const, title: "Capability registry", description: "Live Entity connection, heartbeat and registry truth. Cached schema presence is never presented as health.", endpoint: "/api/v1/agent/entities", secondaryEndpoint: "/api/v1/agent/tools/matrix?limit=25", collection: { defaultPageSize: 25, maxPageSize: 100, search: true }, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
