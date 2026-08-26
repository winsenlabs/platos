import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface, type SurfaceConfig } from "~/services/m4Route.server";
const config: SurfaceConfig = {
  surface: "conversations" as const,
  title: "Threads",
  description: "Long Thread history is paged and uses Turn as the activity unit.",
  endpoint: (params) => `/api/v1/agent/threads?agentId=${encodeURIComponent(params.agentId ?? "")}`,
  collection: { defaultPageSize: 25, maxPageSize: 100 },
  provenance: "Canonical clean database ancestry and platos-agent API",
};
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
