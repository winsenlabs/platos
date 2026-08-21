import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface, type SurfaceConfig } from "~/services/m4Route.server";
const config: SurfaceConfig = { surface: "conversations", title: "Threads", description: "Long Thread history is cursor-paged and uses Turn as the activity unit.", endpoint: (params, url) => `/api/v1/agent/threads?agentId=${encodeURIComponent(params.agentId ?? "")}&allUsers=true&limit=${encodeURIComponent(url.searchParams.get("limit") ?? "50")}&offset=${encodeURIComponent(url.searchParams.get("offset") ?? "0")}`, secondaryEndpoint: undefined, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
