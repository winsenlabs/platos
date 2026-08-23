import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "monitoring" as const, title: "Monitoring and usage", description: "Every semantic value comes from the canonical usage ledger. The dashboard only formats returned values.", endpoint: "/api/v1/agent/monitoring/summary", secondaryEndpoint: "/api/v1/agent/monitoring/cost-by-agent?days=7&limit=40", provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }