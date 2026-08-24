import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";

const config = { surface: "files-attachments" as const, title: "Conversation attachments", description: "Presigned downloads for one scoped Thread. A missing URL honestly indicates unavailable object storage.", endpoint: "/api/v1/agent/files/threads/:threadId/attachments", collection: { defaultPageSize: 25, maxPageSize: 100, search: true, filters: ["mime"] }, provenance: "Canonical operator-only Files hierarchy and object-store presigning" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
