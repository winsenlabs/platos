import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface, type SurfaceConfig } from "~/services/m4Route.server";
const config: SurfaceConfig = {
  surface: "monitoring-users" as const,
  title: "End-user usage",
  description: "Completed Turn usage attributed to EndUsers without blurring operator identities.",
  endpoint: (_params, url) => {
    const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    const limit = Math.min(100, Math.max(10, Number.isFinite(requestedLimit) ? requestedLimit : 50));
    const cursor = url.searchParams.get("cursor") ?? "";
    const safeCursor = /^[A-Za-z0-9_-]{1,100}$/.test(cursor) ? cursor : "";
    return `/api/v1/agent/monitoring/users?limit=${limit}&sinceDays=7${safeCursor ? `&cursor=${encodeURIComponent(safeCursor)}` : ""}`;
  },
  provenance: "Canonical EndUser identities, completed Turns and immutable usage ledger",
};
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
