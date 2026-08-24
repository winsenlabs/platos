import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";

const config = {
  surface: "trace" as const,
  title: "Trace",
  description: "Nested spans, persisted messages, duration, cost and failure attribution for this Thread.",
  endpoint: "/api/v1/agent/monitoring/trace/:threadId",
  secondaryEndpoint: "/api/v1/agent/monitoring/tool-audit?threadId=:threadId",
  provenance: "Canonical clean observability and Tool audit stores",
  notFoundAsResponse: true,
};

export async function loader(args: LoaderFunctionArgs) {
  return loadSurface(args, config);
}

export default function TraceRoute() {
  return <M4Surface data={useLoaderData<typeof loader>()} />;
}
