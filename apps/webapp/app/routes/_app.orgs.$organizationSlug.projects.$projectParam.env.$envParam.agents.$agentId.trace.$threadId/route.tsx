import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "trace", title: "Trace", description: "Spans and Tool Call audit data from the clean observability store.", endpoint: "/api/v1/agent/monitoring/trace/:threadId", secondaryEndpoint: "/api/v1/agent/monitoring/tool-audit?threadId=:threadId", provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }