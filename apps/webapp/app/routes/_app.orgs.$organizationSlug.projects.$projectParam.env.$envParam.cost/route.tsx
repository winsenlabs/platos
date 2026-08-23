import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface, type SurfaceConfig } from "~/services/m4Route.server";

const config: SurfaceConfig = {
  surface: "cost" as const,
  title: "Cost",
  description: "Turns, canonical token lanes and historically pinned pricing provenance from the usage ledger.",
  endpoint: (_params, url) => {
    const date = url.searchParams.get("date");
    return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `/api/v1/agent/monitoring/cost?date=${date}` : "/api/v1/agent/monitoring/cost";
  },
  secondaryEndpoint: "/api/v1/agent/monitoring/cost-by-agent?days=30&limit=100",
  supportingEndpoint: "/api/v1/agent/monitoring/cost-by-model?days=30&limit=100",
  provenance: "Immutable Turn and Step usage snapshots with historically pinned model rate cards",
};
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function CostRoute() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
