import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface, type SurfaceConfig } from "~/services/m4Route.server";

const config: SurfaceConfig = {
  surface: "conversations" as const,
  title: "Threads",
  description: "Environment-wide Thread history using Turn as the activity unit.",
  endpoint: "/api/v1/agent/threads",
  collection: { defaultPageSize: 25, maxPageSize: 100 },
  provenance: "Canonical Environment-scoped Thread and Turn rows",
};
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function ThreadsRoute() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
