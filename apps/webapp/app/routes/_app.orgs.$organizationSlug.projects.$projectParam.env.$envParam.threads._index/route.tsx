import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface, type SurfaceConfig } from "~/services/m4Route.server";

function bounded(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
const config: SurfaceConfig = {
  surface: "conversations" as const,
  title: "Threads",
  description: "Environment-wide Thread history using Turn as the activity unit.",
  endpoint: (_params, url) => `/api/v1/agent/threads?allUsers=true&limit=${bounded(url.searchParams.get("limit"), 50, 10, 100)}&offset=${bounded(url.searchParams.get("offset"), 0, 0, 100_000)}`,
  provenance: "Canonical Environment-scoped Thread and Turn rows",
};
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function ThreadsRoute() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
