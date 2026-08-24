import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface, type SurfaceConfig } from "~/services/m4Route.server";
const config: SurfaceConfig = { surface: "conversations" as const, title: "Threads", description: "Long Thread history is paged and uses Turn as the activity unit.", endpoint: (params, url) => {
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const rawOffset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const limit = Math.min(100, Math.max(10, Number.isFinite(rawLimit) ? rawLimit : 50));
  const offset = Math.min(100_000, Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0));
  return `/api/v1/agent/threads?agentId=${encodeURIComponent(params.agentId ?? "")}&allUsers=true&limit=${limit}&offset=${offset}`;
}, secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
