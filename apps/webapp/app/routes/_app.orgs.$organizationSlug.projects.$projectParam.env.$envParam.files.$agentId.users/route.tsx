import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";

const config = { surface: "files-users" as const, title: "File users", description: "End users with persisted attachments for this Agent.", endpoint: "/api/v1/agent/files/agents/:agentId/users", provenance: "Canonical operator-only Files hierarchy" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
