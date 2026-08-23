import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "governance" as const, title: "Governance", description: "Approvals, safety events and prominent cross-scope Tool Call auditing.", endpoint: "/api/v1/agent/monitoring/governance?sinceDays=7", secondaryEndpoint: "/api/v1/agent/monitoring/safety-events", provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }