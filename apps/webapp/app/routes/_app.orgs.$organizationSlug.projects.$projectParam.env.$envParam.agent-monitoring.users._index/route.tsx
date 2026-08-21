import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "monitoring", title: "End-user usage", description: "Completed Turn usage attributed to EndUsers without blurring operator identities.", endpoint: "/api/v1/agent/monitoring/users?limit=500&sinceDays=7", secondaryEndpoint: "/api/v1/agent/monitoring/cost-by-user?days=7&limit=100", provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }